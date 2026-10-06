// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SMT Receipts
/// @notice A trading agent's calls, sealed on Monad before the market moves and graded later
///         against RedStone-signed prices at exact timestamps.
///
///         - A call is sealed in the clear: pair, direction (LONG / SHORT / WAIT), conviction and
///           the hash of the agent's published reasoning. Every pair the agent follows is sealed in
///           every batch, WAITs included, so a batch cannot leave out the calls that look bad.
///         - Entry is the first RedStone price tick strictly after the seal block; exit is entry
///           plus the horizon. Both are read from signed price packages and checked here, so the
///           grade is a fact of the chain, not a number the agent reports.
///         - Anyone can grade. A call that is not graded inside the grading window expires and
///           counts as a miss that paid its fees, so letting a bad call lapse never helps.
///         - There is no owner, no admin key and no upgrade path. Nobody can edit, delete or
///           re-date a receipt, including whoever deployed this contract.
contract SMTReceipts {
    // ── Clock ────────────────────────────────────────────────────────────────────────────────
    /// RedStone signs one package per feed every 10 seconds, on 10-second boundaries.
    uint256 public constant TICK = 10;
    uint256 public constant MIN_HORIZON = 10 minutes;
    uint256 public constant MAX_HORIZON = 12 hours;
    /// Measured from the entry tick. RedStone's public gateway keeps about 24 hours of signed
    /// history, so a grade has to land inside this window or the call expires.
    uint256 public constant GRADE_WINDOW = 22 hours;
    /// A published call older than this can't be sealed: a receipt has to be fresh when made.
    uint256 public constant MAX_SOURCE_AGE = 3 hours;
    uint256 public constant MAX_FEEDS = 16;

    // ── Vocabulary ───────────────────────────────────────────────────────────────────────────
    uint8 public constant WAIT = 0;
    uint8 public constant LONG = 1;
    uint8 public constant SHORT = 2;

    uint8 public constant SEALED = 1; // has LONG/SHORT calls waiting for their horizon
    uint8 public constant GRADED = 2; // graded against signed prices
    uint8 public constant EXPIRED = 3; // nobody graded it in time; counted as misses
    uint8 public constant CLOSED = 4; // all WAIT: nothing to grade

    // ── Oracle: RedStone signer set, fixed at deployment ─────────────────────────────────────
    address internal immutable SIGNER_0;
    address internal immutable SIGNER_1;
    address internal immutable SIGNER_2;
    address internal immutable SIGNER_3;
    address internal immutable SIGNER_4;
    uint8 public immutable SIGNER_THRESHOLD;

    /// Last 9 bytes of every RedStone payload.
    bytes9 internal constant REDSTONE_MARKER = 0x000002ed57011e0000;
    uint256 internal constant HALF_CURVE_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // ── State ────────────────────────────────────────────────────────────────────────────────
    struct Agent {
        address publisher;
        uint16 feeBps; // round-trip cost the agent declares; a call must beat it to count as a hit
        uint8 nFeeds;
        uint40 lastSourceTs; // each published snapshot is sealed at most once, and in order
        string name;
        string source; // where the agent publishes its calls
    }

    struct Stats {
        uint32 batches;
        uint32 calls; // LONG + SHORT
        uint32 waits;
        uint32 graded;
        uint32 hits; // net of the agent's declared round-trip cost
        uint32 expired;
        int64 sumNetPpm; // sum over graded + expired calls, parts per million of price
    }

    struct Batch {
        uint32 agentId;
        uint40 sealedAt;
        uint32 horizon;
        uint32 dirs; // 2 bits per feed, feed i at bits [2i, 2i+1]
        uint8 nDir;
        uint8 status;
        uint40 sealBlock; // block of the Sealed event, so a reader needs no log range scan
        uint40 closeBlock; // block of the Graded / Expired event (or the seal block if CLOSED)
    }

    uint256 public agentCount;
    mapping(uint256 => Agent) internal _agents;
    mapping(uint256 => bytes32[]) internal _feeds;
    mapping(uint256 => Stats) public stats;
    mapping(address => uint256) public agentOf;
    Batch[] internal _batches;

    // ── Events ───────────────────────────────────────────────────────────────────────────────
    event AgentRegistered(
        uint256 indexed agentId, address indexed publisher, string name, string source, uint16 feeBps, bytes32[] feeds
    );
    event Sealed(
        uint256 indexed batchId,
        uint256 indexed agentId,
        uint64 sourceTs,
        bytes32 snapshotHash,
        uint64 entryTs,
        uint64 exitTs,
        uint256 calls,
        bytes32[] reasonHashes,
        string[] whys
    );
    event Graded(
        uint256 indexed batchId,
        uint256 indexed agentId,
        uint8[] feedIndex,
        uint256[] entryPrice,
        uint256[] exitPrice,
        int32[] movePpm,
        int32[] netPpm,
        uint8 hits
    );
    event Expired(uint256 indexed batchId, uint256 indexed agentId, uint8 missed);

    // ── Errors ───────────────────────────────────────────────────────────────────────────────
    error BadSignerSet();
    error AlreadyRegistered();
    error BadFeeds();
    error BadFee();
    error NotPublisher();
    error LengthMismatch();
    error BadHorizon();
    error StaleSource();
    error BadDirection();
    error BadConfidence();
    error NoSuchBatch();
    error NotGradeable();
    error TooEarly();
    error WindowClosed();
    error WindowOpen();
    error BadPayload();
    error WrongTimestamp(uint256 got, uint256 want);
    error BadSignature();
    error UnknownSigner(address signer);
    error NotEnoughSigners(bytes32 feedId, uint256 got);
    error ZeroPrice(bytes32 feedId);

    constructor(address[5] memory signerSet, uint8 threshold) {
        if (threshold == 0 || threshold > 5) revert BadSignerSet();
        for (uint256 i; i < 5; ++i) {
            if (signerSet[i] == address(0)) revert BadSignerSet();
            for (uint256 j; j < i; ++j) {
                if (signerSet[i] == signerSet[j]) revert BadSignerSet();
            }
        }
        SIGNER_0 = signerSet[0];
        SIGNER_1 = signerSet[1];
        SIGNER_2 = signerSet[2];
        SIGNER_3 = signerSet[3];
        SIGNER_4 = signerSet[4];
        SIGNER_THRESHOLD = threshold;
    }

    // ── Agents ───────────────────────────────────────────────────────────────────────────────

    /// @notice Register the calling address as the publisher of one agent's calls.
    /// @param feeds RedStone feed ids (e.g. bytes32("BTC")) in the order every batch will use.
    /// @param feeBps the round-trip trading cost the agent's calls must beat; fixed forever.
    function registerAgent(string calldata name, string calldata source, uint16 feeBps, bytes32[] calldata feeds)
        external
        returns (uint256 agentId)
    {
        if (agentOf[msg.sender] != 0) revert AlreadyRegistered();
        if (feeds.length == 0 || feeds.length > MAX_FEEDS) revert BadFeeds();
        if (feeBps > 1000) revert BadFee();
        for (uint256 i; i < feeds.length; ++i) {
            if (feeds[i] == bytes32(0)) revert BadFeeds();
            for (uint256 j; j < i; ++j) {
                if (feeds[i] == feeds[j]) revert BadFeeds();
            }
        }
        agentId = ++agentCount;
        Agent storage a = _agents[agentId];
        a.publisher = msg.sender;
        a.feeBps = feeBps;
        a.nFeeds = uint8(feeds.length);
        a.name = name;
        a.source = source;
        _feeds[agentId] = feeds;
        agentOf[msg.sender] = agentId;
        emit AgentRegistered(agentId, msg.sender, name, source, feeBps, feeds);
    }

    // ── Seal ─────────────────────────────────────────────────────────────────────────────────

    /// @notice Seal one published snapshot of the agent's calls: one entry per feed, in order.
    /// @param sourceTs when the agent published the snapshot (unix seconds)
    /// @param snapshotHash keccak256 of the exact published snapshot bytes
    /// @param horizon seconds from entry to exit
    /// @param calls feed i in bits [16i, 16i+16): direction << 14 | convictionBps
    /// @param reasonHashes keccak256 of each call's published reasoning (canonical JSON)
    /// @param whys the plain-language reason for each LONG/SHORT call ("" for a WAIT is fine)
    function seal(
        uint64 sourceTs,
        bytes32 snapshotHash,
        uint32 horizon,
        uint256 calls,
        bytes32[] calldata reasonHashes,
        string[] calldata whys
    ) external returns (uint256 batchId) {
        uint256 agentId = agentOf[msg.sender];
        if (agentId == 0) revert NotPublisher();
        Agent storage a = _agents[agentId];
        uint256 n = a.nFeeds;
        if (reasonHashes.length != n || whys.length != n || (n < MAX_FEEDS && calls >> (16 * n) != 0)) {
            revert LengthMismatch();
        }
        if (horizon < MIN_HORIZON || horizon > MAX_HORIZON || horizon % TICK != 0) revert BadHorizon();
        if (sourceTs <= a.lastSourceTs || sourceTs > block.timestamp || block.timestamp - sourceTs > MAX_SOURCE_AGE) {
            revert StaleSource();
        }

        uint32 packed;
        uint8 nDir;
        for (uint256 i; i < n; ++i) {
            uint256 word = (calls >> (16 * i)) & 0xFFFF;
            uint256 d = word >> 14;
            if (d > SHORT) revert BadDirection();
            if (word & 0x3FFF > 10_000) revert BadConfidence();
            packed |= uint32(d) << uint32(2 * i);
            if (d != WAIT) ++nDir;
        }
        a.lastSourceTs = uint40(sourceTs);

        uint8 status = nDir == 0 ? CLOSED : SEALED;
        batchId = _batches.length;
        _batches.push(
            Batch({
                agentId: uint32(agentId),
                sealedAt: uint40(block.timestamp),
                horizon: horizon,
                dirs: packed,
                nDir: nDir,
                status: status,
                sealBlock: uint40(block.number),
                closeBlock: status == CLOSED ? uint40(block.number) : 0
            })
        );

        Stats storage s = stats[agentId];
        s.batches += 1;
        s.calls += nDir;
        s.waits += uint32(n - nDir);

        uint64 entryTs = uint64(_entryTs(block.timestamp));
        emit Sealed(batchId, agentId, sourceTs, snapshotHash, entryTs, entryTs + horizon, calls, reasonHashes, whys);
    }

    // ── Grade ────────────────────────────────────────────────────────────────────────────────

    /// @notice Grade a sealed batch. Anyone can call this.
    /// @param entryPayload RedStone payload signed at exactly the batch's entry tick
    /// @param exitPayload RedStone payload signed at exactly the batch's exit tick
    function grade(uint256 batchId, bytes calldata entryPayload, bytes calldata exitPayload) external {
        if (batchId >= _batches.length) revert NoSuchBatch();
        Batch storage b = _batches[batchId];
        if (b.status != SEALED) revert NotGradeable();
        uint256 entryTs = _entryTs(b.sealedAt);
        uint256 exitTs = entryTs + b.horizon;
        if (block.timestamp < exitTs) revert TooEarly();
        if (block.timestamp >= entryTs + GRADE_WINDOW) revert WindowClosed();

        (bytes32[] memory ids, uint8[] memory idx, uint8[] memory dirs) = _directional(b);
        uint256[] memory p0 = _prices(entryPayload, ids, entryTs * 1000);
        uint256[] memory p1 = _prices(exitPayload, ids, exitTs * 1000);

        int256 feePpm = int256(uint256(_agents[b.agentId].feeBps)) * 100;
        int32[] memory move = new int32[](ids.length);
        int32[] memory net = new int32[](ids.length);
        uint8 hits;
        int256 sumNet;
        for (uint256 i; i < ids.length; ++i) {
            int256 m = ((int256(p1[i]) - int256(p0[i])) * 1_000_000) / int256(p0[i]);
            int256 r = (dirs[i] == LONG ? m : -m) - feePpm;
            move[i] = _clamp32(m);
            net[i] = _clamp32(r);
            if (r > 0) ++hits;
            sumNet += net[i];
        }

        b.status = GRADED;
        b.closeBlock = uint40(block.number);
        Stats storage s = stats[b.agentId];
        s.graded += uint32(ids.length);
        s.hits += hits;
        s.sumNetPpm += int64(sumNet);

        emit Graded(batchId, b.agentId, idx, p0, p1, move, net, hits);
    }

    /// @notice Close a batch nobody graded in time. Anyone can call this. Every LONG/SHORT call in
    ///         it counts as a miss that paid the agent's declared round-trip cost.
    function expire(uint256 batchId) external {
        if (batchId >= _batches.length) revert NoSuchBatch();
        Batch storage b = _batches[batchId];
        if (b.status != SEALED) revert NotGradeable();
        if (block.timestamp < _entryTs(b.sealedAt) + GRADE_WINDOW) revert WindowOpen();
        b.status = EXPIRED;
        b.closeBlock = uint40(block.number);
        Stats storage s = stats[b.agentId];
        s.expired += b.nDir;
        s.sumNetPpm -= int64(int256(uint256(_agents[b.agentId].feeBps)) * 100 * int256(uint256(b.nDir)));
        emit Expired(batchId, b.agentId, b.nDir);
    }

    // ── Views ────────────────────────────────────────────────────────────────────────────────

    function batchCount() external view returns (uint256) {
        return _batches.length;
    }

    function agent(uint256 agentId)
        external
        view
        returns (
            address publisher,
            uint16 feeBps,
            uint40 lastSourceTs,
            string memory name,
            string memory source,
            bytes32[] memory feeds
        )
    {
        Agent storage a = _agents[agentId];
        return (a.publisher, a.feeBps, a.lastSourceTs, a.name, a.source, _feeds[agentId]);
    }

    function batch(uint256 batchId) external view returns (Batch memory b, uint256 entryTs, uint256 exitTs) {
        if (batchId >= _batches.length) revert NoSuchBatch();
        b = _batches[batchId];
        entryTs = _entryTs(b.sealedAt);
        exitTs = entryTs + b.horizon;
    }

    /// @notice What a grader has to price: the batch's LONG/SHORT feeds and the two exact ticks.
    function gradeRequest(uint256 batchId)
        external
        view
        returns (bytes32[] memory feedIds, uint8[] memory feedIndex, uint256 entryTsMs, uint256 exitTsMs)
    {
        if (batchId >= _batches.length) revert NoSuchBatch();
        Batch storage b = _batches[batchId];
        (feedIds, feedIndex,) = _directional(b);
        uint256 entryTs = _entryTs(b.sealedAt);
        return (feedIds, feedIndex, entryTs * 1000, (entryTs + b.horizon) * 1000);
    }

    function signers() external view returns (address[5] memory) {
        return [SIGNER_0, SIGNER_1, SIGNER_2, SIGNER_3, SIGNER_4];
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────

    /// The first RedStone tick strictly after the seal: the call existed before this price did.
    function _entryTs(uint256 sealedAt) internal pure returns (uint256) {
        return (sealedAt / TICK + 1) * TICK;
    }

    function _directional(Batch storage b)
        internal
        view
        returns (bytes32[] memory ids, uint8[] memory idx, uint8[] memory dirs)
    {
        bytes32[] storage feeds = _feeds[b.agentId];
        uint256 n = feeds.length;
        uint32 packed = b.dirs;
        ids = new bytes32[](b.nDir);
        idx = new uint8[](b.nDir);
        dirs = new uint8[](b.nDir);
        uint256 k;
        for (uint256 i; i < n; ++i) {
            uint8 d = uint8((packed >> uint32(2 * i)) & 3);
            if (d != WAIT) {
                ids[k] = feeds[i];
                idx[k] = uint8(i);
                dirs[k] = d;
                ++k;
            }
        }
    }

    function _clamp32(int256 x) internal pure returns (int32) {
        if (x > type(int32).max) return type(int32).max;
        if (x < type(int32).min) return type(int32).min;
        return int32(x);
    }

    function _signerIndex(address s) internal view returns (uint256) {
        if (s == SIGNER_0) return 0;
        if (s == SIGNER_1) return 1;
        if (s == SIGNER_2) return 2;
        if (s == SIGNER_3) return 3;
        if (s == SIGNER_4) return 4;
        revert UnknownSigner(s);
    }

    /// @dev Verifies a RedStone payload and returns the median price of each requested feed.
    ///
    ///      Payload layout (read from the end):
    ///        [package]... [packagesCount:2] [unsignedMetadata:N] [N:3] [marker:9]
    ///      Package layout:
    ///        [dataPoint]... [timestampMs:6] [valueByteSize:4] [dataPointsCount:3] [signature:65]
    ///        dataPoint = [feedId:32][value:valueByteSize]
    ///      The signer signs keccak256 of every package byte before the signature.
    ///
    ///      Every package must carry exactly `tsMs`; each signer counts once per feed; a feed
    ///      needs SIGNER_THRESHOLD distinct authorised signers; the price is their median.
    function _prices(bytes calldata payload, bytes32[] memory ids, uint256 tsMs)
        internal
        view
        returns (uint256[] memory out)
    {
        uint256 nIds = ids.length;
        out = new uint256[](nIds);
        if (nIds == 0) return out;

        uint256[] memory vals = new uint256[](nIds * 5);
        uint256[] memory counts = new uint256[](nIds);
        uint256[] memory seen = new uint256[](nIds);

        uint256 end = payload.length;
        if (end < 14 || bytes9(payload[end - 9:end]) != REDSTONE_MARKER) revert BadPayload();
        end -= 9;
        uint256 metaSize = uint24(bytes3(payload[end - 3:end]));
        end -= 3;
        if (end < metaSize + 2) revert BadPayload();
        end -= metaSize;
        uint256 nPkgs = uint16(bytes2(payload[end - 2:end]));
        end -= 2;

        for (uint256 p; p < nPkgs; ++p) {
            if (end < 78) revert BadPayload();
            uint256 sigStart = end - 65;
            uint256 nPoints = uint24(bytes3(payload[sigStart - 3:sigStart]));
            uint256 valueSize = uint32(bytes4(payload[sigStart - 7:sigStart - 3]));
            uint256 ts = uint48(bytes6(payload[sigStart - 13:sigStart - 7]));
            if (valueSize != 32 || nPoints == 0) revert BadPayload();
            if (ts != tsMs) revert WrongTimestamp(ts, tsMs);
            uint256 pointsLen = nPoints * 64;
            if (sigStart < 13 + pointsLen) revert BadPayload();
            uint256 start = sigStart - 13 - pointsLen;

            uint256 signer = _signerIndex(_recover(keccak256(payload[start:sigStart]), payload[sigStart:end]));
            uint256 bit = 1 << signer;

            for (uint256 q; q < nPoints; ++q) {
                uint256 o = start + q * 64;
                bytes32 feedId = bytes32(payload[o:o + 32]);
                for (uint256 f; f < nIds; ++f) {
                    if (ids[f] == feedId) {
                        if (seen[f] & bit == 0) {
                            seen[f] |= bit;
                            vals[f * 5 + counts[f]] = uint256(bytes32(payload[o + 32:o + 64]));
                            ++counts[f];
                        }
                        break;
                    }
                }
            }
            end = start;
        }
        if (end != 0) revert BadPayload();

        for (uint256 f; f < nIds; ++f) {
            uint256 c = counts[f];
            if (c < SIGNER_THRESHOLD) revert NotEnoughSigners(ids[f], c);
            uint256 m = _median(vals, f * 5, c);
            if (m == 0) revert ZeroPrice(ids[f]);
            out[f] = m;
        }
    }

    function _recover(bytes32 h, bytes calldata sig) internal pure returns (address s) {
        bytes32 r = bytes32(sig[0:32]);
        bytes32 sv = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if ((v != 27 && v != 28) || uint256(sv) > HALF_CURVE_ORDER) revert BadSignature();
        s = ecrecover(h, v, r, sv);
        if (s == address(0)) revert BadSignature();
    }

    /// Median of vals[from .. from+c), c <= 5; the mean of the middle two when c is even.
    function _median(uint256[] memory vals, uint256 from, uint256 c) internal pure returns (uint256) {
        for (uint256 i = 1; i < c; ++i) {
            uint256 x = vals[from + i];
            uint256 j = i;
            while (j > 0 && vals[from + j - 1] > x) {
                vals[from + j] = vals[from + j - 1];
                --j;
            }
            vals[from + j] = x;
        }
        return c % 2 == 1 ? vals[from + c / 2] : (vals[from + c / 2 - 1] + vals[from + c / 2]) / 2;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IMsgSender} from "@uniswap/v4-periphery/src/interfaces/IMsgSender.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title  WinCutHook
/// @notice A Uniswap v4 hook that charges a success fee ONLY on realised profit.
///         A losing sell charges nothing and banks a credit against future gains.
/// @dev    Permissions are FROZEN: beforeInitialize | afterSwap | afterSwapReturnDelta.
///         The deployed address must carry low bits 0x2044 == (1<<13 | 1<<6 | 1<<2).
///         Changing permissions changes the address, which changes every PoolKey,
///         which invalidates every pool. Do not add flags after launch.
contract WinCutHook is BaseHook, Ownable {
    using CurrencyLibrary for Currency;

    // ----------------------------------------------------------------- config

    /// @notice The quote currency. Every pool on this hook must contain it.
    /// @dev    Pinned at deploy so cost basis is always denominated in ONE unit.
    ///         On Arc, USDC is native (18dp) AND an ERC-20 interface (6dp) at
    ///         0x3600...0000. Mixing them is a 1e12 accounting error, so the
    ///         hook accepts exactly one and rejects pools built on the other.
    Currency public immutable QUOTE;

    /// @notice 10% of realised profit.
    uint256 public constant FEE_BPS = 1_000;
    /// @notice 50% of the fee to the copied trader.
    uint256 public constant TRADER_BPS = 5_000;
    /// @notice 20% of the fee to the referrer.
    uint256 public constant REFERRER_BPS = 2_000;
    uint256 private constant BPS = 10_000;

    address public launcher;
    address public treasury;
    /// @notice Per-trade cap in QUOTE units, 0 disables. Safety rail for real funds.
    uint256 public maxTradeSize;
    bool public paused;

    /// @notice Only swaps arriving through a trusted router can be attributed.
    mapping(address => bool) public trustedRouter;

    // ------------------------------------------------------------------ state

    struct Position {
        uint128 amount; // coins held, from OUR recorded swaps only. Never balanceOf.
        uint128 cost;   // total QUOTE paid for exactly those coins.
    }

    mapping(address => mapping(PoolId => Position)) public positions;

    /// @notice Unused realised losses, offset against future gains.
    /// @dev    GLOBAL per trader, not per coin. Per-coin would still tax a win on
    ///         one memecoin while a loss on another sat unused.
    mapping(address => uint256) public lossCredit;

    /// @notice Locked on the first attributed buy and never reassigned.
    mapping(address => address) public referrerOf;
    mapping(address => mapping(PoolId => address)) public followedOf;
    mapping(PoolId => address) public creatorOf;

    /// @notice Pull-based earnings. Never pushed, so one blocklisted recipient
    ///         can never make another trader's sell revert.
    mapping(address => uint256) public claimable;

    // ----------------------------------------------------------------- events

    event Bought(
        address indexed trader, PoolId indexed id, uint128 coins, uint256 cost, address followed, address referrer
    );
    event Sold(address indexed trader, PoolId indexed id, uint128 coins, uint256 proceeds, int256 pnl, uint256 fee);
    event FeeSplit(
        address indexed trader,
        PoolId indexed id,
        uint256 fee,
        address followed,
        uint256 traderCut,
        address referrer,
        uint256 referrerCut,
        uint256 treasuryCut
    );
    event LossCredited(address indexed trader, uint256 loss, uint256 newCredit);
    event CreditConsumed(address indexed trader, uint256 used, uint256 remaining);
    event Claimed(address indexed account, uint256 amount);
    event CoinRegistered(PoolId indexed id, address creator);
    event RouterTrustSet(address indexed router, bool trusted);
    event PausedSet(bool paused);

    // ----------------------------------------------------------------- errors

    error NotLauncher();
    error BadQuoteCurrency();
    error HookPaused();
    error TradeTooLarge();
    error NothingToClaim();
    error ZeroAddress();

    /// @param _owner the admin address. Passed explicitly and NOT taken from
    ///        msg.sender, because the hook is deployed through the canonical
    ///        CREATE2 factory to mine its permission bits. msg.sender inside the
    ///        constructor is therefore the factory, which would otherwise end up
    ///        owning the hook and lock the real deployer out of setLauncher().
    constructor(IPoolManager _pm, Currency _quote, address _treasury, uint256 _maxTradeSize, address _owner)
        BaseHook(_pm)
        Ownable(_owner)
    {
        if (_treasury == address(0) || _owner == address(0)) revert ZeroAddress();
        QUOTE = _quote;
        treasury = _treasury;
        maxTradeSize = _maxTradeSize;
    }

    /// @dev Needed when QUOTE is the native currency: take() sends real value here.
    receive() external payable {}

    // ------------------------------------------------------------ permissions

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ------------------------------------------------------------------ admin

    function setLauncher(address _launcher) external onlyOwner {
        launcher = _launcher;
    }

    function setTrustedRouter(address router, bool trusted) external onlyOwner {
        trustedRouter[router] = trusted;
        emit RouterTrustSet(router, trusted);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function setMaxTradeSize(uint256 m) external onlyOwner {
        maxTradeSize = m;
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
    }

    function registerCoin(PoolId id, address creator) external {
        if (msg.sender != launcher) revert NotLauncher();
        creatorOf[id] = creator;
        emit CoinRegistered(id, creator);
    }

    // ------------------------------------------------------------------ hooks

    /// @dev Only the launcher may open pools on this hook, and one side must be
    ///      QUOTE. Without this, anyone could point a fake-token pool at a hook
    ///      that custodies funds.
    function _beforeInitialize(address sender, PoolKey calldata key, uint160)
        internal
        view
        override
        returns (bytes4)
    {
        if (sender != launcher) revert NotLauncher();
        if (!(key.currency0 == QUOTE || key.currency1 == QUOTE)) revert BadQuoteCurrency();
        return IHooks.beforeInitialize.selector;
    }

    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata,
        BalanceDelta delta,
        bytes calldata hookData
    ) internal override returns (bytes4, int128) {
        if (paused) revert HookPaused();

        // Unidentified trader => zero fee, no record. Deliberate: taxing every
        // unattributed sell would deter arbitrage, let the pool price drift above
        // other venues, and get the coin flagged as a sell-tax token.
        address trader = _resolveTrader(sender);
        if (trader == address(0)) return (IHooks.afterSwap.selector, 0);

        PoolId id = key.toId();
        bool quoteIs0 = key.currency0 == QUOTE;
        int256 qDelta = quoteIs0 ? int256(delta.amount0()) : int256(delta.amount1());
        int256 cDelta = quoteIs0 ? int256(delta.amount1()) : int256(delta.amount0());

        // Sign convention, verified against v4-core Hooks.afterSwap:
        // negative delta = the swapper owes the pool, positive = the pool owes them.
        if (cDelta > 0 && qDelta < 0) {
            uint256 spent = uint256(-qDelta);
            if (maxTradeSize != 0 && spent > maxTradeSize) revert TradeTooLarge();
            _recordBuy(trader, id, uint128(uint256(cDelta)), spent, hookData);
            return (IHooks.afterSwap.selector, 0);
        }

        if (cDelta < 0 && qDelta > 0) {
            uint256 gross = uint256(qDelta);
            if (maxTradeSize != 0 && gross > maxTradeSize) revert TradeTooLarge();
            return _handleSell(trader, id, uint128(uint256(-cDelta)), gross);
        }

        return (IHooks.afterSwap.selector, 0);
    }

    // -------------------------------------------------------------- internals

    function _resolveTrader(address sender) internal view returns (address) {
        if (!trustedRouter[sender]) return address(0);
        try IMsgSender(sender).msgSender() returns (address user) {
            return user;
        } catch {
            return address(0);
        }
    }

    function _recordBuy(address trader, PoolId id, uint128 coins, uint256 spent, bytes calldata hookData) internal {
        Position storage pos = positions[trader][id];
        pos.amount += coins;
        pos.cost += uint128(spent);

        _attribute(trader, id, hookData);
        emit Bought(trader, id, coins, spent, followedOf[trader][id], referrerOf[trader]);
    }

    /// @dev hookData is user-controlled, so every self-dealing case is guarded here.
    function _attribute(address trader, PoolId id, bytes calldata hookData) internal {
        (address followed, address referrer) = _decodeAttribution(hookData);
        if (followed == trader) followed = address(0);
        if (referrer == trader) referrer = address(0);

        if (followed != address(0)) followedOf[trader][id] = followed;
        // Locked on first buy, so nobody can later redirect their referrer to
        // themselves and claw back part of their own fee.
        if (referrer != address(0) && referrerOf[trader] == address(0)) {
            referrerOf[trader] = referrer;
        }
    }

    function _decodeAttribution(bytes calldata hookData) internal pure returns (address, address) {
        if (hookData.length != 64) return (address(0), address(0));
        return abi.decode(hookData, (address, address));
    }

    function _handleSell(address trader, PoolId id, uint128 sold, uint256 gross)
        internal
        returns (bytes4, int128)
    {
        (uint128 attributed, uint256 basis, uint256 proceeds) = _consume(trader, id, sold, gross);

        // Coins we never recorded (airdropped, transferred in, bought elsewhere)
        // are fee-free. This kills the airdrop griefing vector: dusting someone
        // can no longer inflate their taxable profit.
        if (attributed == 0) return (IHooks.afterSwap.selector, 0);

        if (proceeds <= basis) {
            uint256 loss = basis - proceeds;
            lossCredit[trader] += loss;
            emit LossCredited(trader, loss, lossCredit[trader]);
            emit Sold(trader, id, attributed, proceeds, -int256(loss), 0);
            return (IHooks.afterSwap.selector, 0);
        }

        uint256 fee = _applyCredit(trader, proceeds - basis);
        if (fee == 0) {
            emit Sold(trader, id, attributed, proceeds, int256(proceeds - basis), 0);
            return (IHooks.afterSwap.selector, 0);
        }

        // take() debits the hook's delta by `fee`; the +fee we return credits it
        // back to zero, so the hook settles within this same unlock.
        poolManager.take(QUOTE, address(this), fee);
        _split(trader, id, fee);

        emit Sold(trader, id, attributed, proceeds, int256(proceeds - basis), fee);
        return (IHooks.afterSwap.selector, int128(uint128(fee)));
    }

    /// @dev Removes the sold slice from the recorded position and returns the
    ///      attributed amount with its proportional basis and proceeds.
    function _consume(address trader, PoolId id, uint128 sold, uint256 gross)
        internal
        returns (uint128 attributed, uint256 basis, uint256 proceeds)
    {
        Position storage pos = positions[trader][id];
        uint128 recorded = pos.amount;
        if (recorded == 0) return (0, 0, 0);

        attributed = sold > recorded ? recorded : sold;
        basis = (uint256(pos.cost) * attributed) / recorded;
        proceeds = (gross * attributed) / sold;

        pos.amount = recorded - attributed;
        pos.cost = uint128(uint256(pos.cost) - basis);
    }

    /// @dev Consumes banked losses before charging, then returns 10% of what remains.
    function _applyCredit(address trader, uint256 gain) internal returns (uint256) {
        uint256 credit = lossCredit[trader];
        uint256 used = credit >= gain ? gain : credit;
        if (used > 0) {
            lossCredit[trader] = credit - used;
            emit CreditConsumed(trader, used, credit - used);
        }
        return ((gain - used) * FEE_BPS) / BPS;
    }

    function _split(address trader, PoolId id, uint256 fee) internal {
        address followed = followedOf[trader][id];
        address referrer = referrerOf[trader];

        // Nobody copied => that share goes to the coin creator.
        if (followed == address(0)) {
            address creator = creatorOf[id];
            followed = creator == address(0) ? treasury : creator;
        }
        if (referrer == address(0)) referrer = treasury;

        uint256 traderCut = (fee * TRADER_BPS) / BPS;
        uint256 referrerCut = (fee * REFERRER_BPS) / BPS;
        uint256 treasuryCut = fee - traderCut - referrerCut; // remainder absorbs dust

        claimable[followed] += traderCut;
        claimable[referrer] += referrerCut;
        claimable[treasury] += treasuryCut;

        emit FeeSplit(trader, id, fee, followed, traderCut, referrer, referrerCut, treasuryCut);
    }

    // ------------------------------------------------------------------ claim

    /// @notice Pull-based payout, CEI ordered. A failing recipient cannot block others.
    function claim() external returns (uint256 amount) {
        amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        QUOTE.transfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    /// @notice THE single source of truth for the fee.
    /// @dev    The frontend MUST call this and derive minOut from netOut. Deriving
    ///         minOut from the gross quote makes every profitable sell revert on
    ///         slippage, because the router checks the post-hook amount.
    function quoteFee(address trader, PoolId id, uint128 sellAmount, uint256 grossOut)
        external
        view
        returns (uint256 fee, uint256 netOut)
    {
        Position memory pos = positions[trader][id];
        if (pos.amount == 0 || sellAmount == 0) return (0, grossOut);

        uint128 attributed = sellAmount > pos.amount ? pos.amount : sellAmount;
        uint256 basis = (uint256(pos.cost) * attributed) / pos.amount;
        uint256 proceeds = (grossOut * attributed) / sellAmount;
        if (proceeds <= basis) return (0, grossOut);

        uint256 gain = proceeds - basis;
        uint256 credit = lossCredit[trader];
        if (credit >= gain) return (0, grossOut);

        fee = ((gain - credit) * FEE_BPS) / BPS;
        netOut = grossOut - fee;
    }

    function positionOf(address trader, PoolId id) external view returns (uint128 amount, uint128 cost) {
        Position memory p = positions[trader][id];
        return (p.amount, p.cost);
    }
}

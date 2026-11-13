use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

/// How a USDC amount gets turned into `token_id` on Rhea, and back.
///
/// USDC has exactly one deep Rhea pool on mainnet (USDC/wNEAR #4512), so every
/// token other than wNEAR needs two hops. The hops are stored rather than
/// derived so that a pool can be re-pointed by the owner without a redeploy.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct TokenConfig {
    pub token_id: AccountId,
    pub symbol: String,
    pub decimals: u8,
    /// Rhea pool ids, in buy order (USDC -> ... -> token).
    pub hops: Vec<Hop>,
    /// Set once the contract has paid NEP-145 storage on `token_id` and on Rhea
    /// for `token_id`. Trading is refused until then: a swap whose output
    /// transfer bounces would leave the proceeds stranded inside Rhea.
    pub registered: bool,
    /// GeckoTerminal pool id used for the chart, e.g. `refv1-4512`.
    pub chart_pool: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Hop {
    pub pool_id: u64,
    pub token_in: AccountId,
    pub token_out: AccountId,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Default)]
pub struct Position {
    /// Raw token units held for this user.
    pub amount: U128,
    /// Raw USDC units paid for `amount`, net of nothing - it is what left the
    /// user's internal balance.
    pub cost_basis_usdc: U128,
    /// Trader being copied, credited 50% of any profit fee.
    pub followed: Option<AccountId>,
    /// Referrer, credited 20% of any profit fee.
    pub referrer: Option<AccountId>,
    /// Block timestamp (ns) of the first buy that opened this position.
    pub opened_at: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Buy,
    Sell,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Trade {
    pub id: u64,
    pub user: AccountId,
    pub token_id: AccountId,
    pub side: Side,
    /// Raw token units bought or sold.
    pub amount: U128,
    /// Raw USDC units paid (buy) or received before fee (sell).
    pub usdc: U128,
    /// Realised profit, raw USDC units. `None` on buys.
    pub pnl: Option<I128Json>,
    /// WinCut fee charged, raw USDC units. Always 0 on buys.
    pub fee: U128,
    pub followed: Option<AccountId>,
    pub timestamp: u64,
}

/// Signed USDC amount for JSON. Borsh-stored as (negative, magnitude) so the
/// sign survives a round trip without relying on a signed-integer serializer.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Default)]
pub struct I128Json {
    pub negative: bool,
    pub abs: U128,
}

impl I128Json {
    pub fn profit(abs: u128) -> Self {
        Self {
            negative: false,
            abs: U128(abs),
        }
    }
    pub fn loss(abs: u128) -> Self {
        Self {
            negative: abs > 0,
            abs: U128(abs),
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Default)]
pub struct TraderStats {
    /// Sum of realised profit minus realised loss, raw USDC units, as a signed pair.
    pub realised_pnl: I128Json,
    /// Raw USDC units bought + sold.
    pub volume_usdc: U128,
    /// Distinct accounts that have ever copied this trader.
    pub followers: u32,
    /// Raw USDC units this trader has earned from followers' profit fees.
    pub earnings_usdc: U128,
    pub trades: u32,
    pub wins: u32,
    pub losses: u32,
}

/// What the single global lock is being held for.
///
/// Swaps and USDC payouts share one lock. Only one swap may be in flight so
/// that the balance delta measured in its callback belongs to exactly one
/// user, and a withdrawal or claim in flight would move the very USDC balance
/// a sell settlement is about to measure.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LockKind {
    Buy,
    Sell,
    Payout,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct SwapLock {
    pub user: AccountId,
    pub token_id: AccountId,
    pub kind: LockKind,
    /// Buy: USDC units sent to Rhea. Sell: token units sent to Rhea.
    /// Payout: USDC units leaving the contract.
    pub amount_in: U128,
    /// Sell only: the position as it stood before the sale, so the settlement
    /// callback can work from the same numbers the user was quoted.
    pub position_amount_before: U128,
    pub cost_basis_before: U128,
    pub min_out: U128,
    pub followed: Option<AccountId>,
    pub referrer: Option<AccountId>,
    pub started_at: u64,
}

/// What `sell` will do, as computed by the pure settlement function. Returned
/// verbatim by `quote_sell_fee` so the UI can show the exact fee before signing.
#[near(serializers = [json, borsh])]
#[derive(Clone, Default, Debug, PartialEq, Eq)]
pub struct SellOutcome {
    /// Portion of the position's cost basis consumed by this sale.
    pub basis_part: U128,
    /// Realised profit or loss on this sale, before any fee.
    pub pnl: I128JsonCmp,
    /// Loss credit the user held going in.
    pub loss_credit_before: U128,
    /// Loss credit consumed to shelter this profit.
    pub credit_used: U128,
    /// Loss credit banked by this sale (only when it is a loss).
    pub credit_banked: U128,
    pub loss_credit_after: U128,
    /// Profit left after the credit, which is what the fee is charged on.
    pub taxable_profit: U128,
    /// 10% of the taxable profit. Zero on a loss, and zero on a profit fully
    /// sheltered by loss credit.
    pub fee: U128,
    pub to_trader: U128,
    pub to_referrer: U128,
    pub to_protocol: U128,
    /// USDC the user actually receives: proceeds - fee.
    pub user_receives: U128,
}

/// Same shape as `I128Json` but with the derives `SellOutcome` needs.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct I128JsonCmp {
    pub negative: bool,
    pub abs: U128,
}

impl From<I128JsonCmp> for I128Json {
    fn from(v: I128JsonCmp) -> Self {
        Self {
            negative: v.negative,
            abs: v.abs,
        }
    }
}

#[near(serializers = [json])]
pub struct PositionView {
    pub token_id: AccountId,
    pub symbol: String,
    pub decimals: u8,
    pub amount: U128,
    pub cost_basis_usdc: U128,
    pub followed: Option<AccountId>,
    pub referrer: Option<AccountId>,
    pub opened_at: u64,
}

#[near(serializers = [json])]
pub struct LeaderboardRow {
    pub account_id: AccountId,
    pub realised_pnl: I128Json,
    pub volume_usdc: U128,
    pub followers: u32,
    pub earnings_usdc: U128,
    pub trades: u32,
    pub wins: u32,
    pub losses: u32,
}

#[near(serializers = [json])]
pub struct ContractConfig {
    pub owner_id: AccountId,
    pub usdc_id: AccountId,
    pub ref_id: AccountId,
    pub fee_bps_of_profit: u16,
    pub trader_share_pct: u8,
    pub referrer_share_pct: u8,
    pub protocol_share_pct: u8,
    pub paused: bool,
    pub swap_in_flight: bool,
    pub total_trades: u64,
    pub trade_ring_capacity: u64,
    /// USDC the protocol owes users because a Rhea payout landed inside Rhea's
    /// own ledger instead of here. `sweep_rhea` recovers it. Normally zero.
    pub shortfall_usdc: U128,
}

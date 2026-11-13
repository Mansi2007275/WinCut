//! NEP-297 events. Every state change a user can see is logged as
//! `EVENT_JSON:{"standard":"wincut","version":"1.0.0","event":"...","data":[...]}`
//! so an indexer can rebuild balances, positions and earnings from the chain
//! alone - which is what the frontend trade feeds read.

use crate::types::{I128Json, LockKind};
use near_sdk::json_types::U128;
use near_sdk::{serde_json::json, AccountId};

pub const STANDARD: &str = "wincut";
pub const VERSION: &str = "1.0.0";

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    near_sdk::env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": STANDARD, "version": VERSION, "event": event, "data": [data] })
    ));
}

pub fn deposit(account_id: &AccountId, amount: u128, new_balance: u128) {
    emit(
        "deposit",
        json!({ "account_id": account_id, "amount": U128(amount), "balance": U128(new_balance) }),
    );
}

pub fn withdraw(account_id: &AccountId, amount: u128, new_balance: u128) {
    emit(
        "withdraw",
        json!({ "account_id": account_id, "amount": U128(amount), "balance": U128(new_balance) }),
    );
}

#[allow(clippy::too_many_arguments)]
pub fn buy(
    account_id: &AccountId,
    token_id: &AccountId,
    usdc_in: u128,
    amount_out: u128,
    position_amount: u128,
    cost_basis: u128,
    followed: &Option<AccountId>,
    referrer: &Option<AccountId>,
) {
    emit(
        "buy",
        json!({
            "account_id": account_id,
            "token_id": token_id,
            "usdc_in": U128(usdc_in),
            "amount_out": U128(amount_out),
            "position_amount": U128(position_amount),
            "cost_basis_usdc": U128(cost_basis),
            "followed": followed,
            "referrer": referrer,
            "fee": U128(0),
        }),
    );
}

#[allow(clippy::too_many_arguments)]
pub fn sell(
    account_id: &AccountId,
    token_id: &AccountId,
    amount: u128,
    proceeds: u128,
    pnl: &I128Json,
    fee: u128,
    credit_used: u128,
    credit_banked: u128,
    loss_credit_after: u128,
    to_trader: u128,
    to_referrer: u128,
    to_protocol: u128,
    followed: &Option<AccountId>,
    referrer: &Option<AccountId>,
) {
    emit(
        "sell",
        json!({
            "account_id": account_id,
            "token_id": token_id,
            "amount": U128(amount),
            "proceeds_usdc": U128(proceeds),
            "pnl_negative": pnl.negative,
            "pnl_abs": pnl.abs,
            "fee": U128(fee),
            "credit_used": U128(credit_used),
            "credit_banked": U128(credit_banked),
            "loss_credit_after": U128(loss_credit_after),
            "to_trader": U128(to_trader),
            "to_referrer": U128(to_referrer),
            "to_protocol": U128(to_protocol),
            "followed": followed,
            "referrer": referrer,
        }),
    );
}

pub fn claim(account_id: &AccountId, amount: u128) {
    emit(
        "claim",
        json!({ "account_id": account_id, "amount": U128(amount) }),
    );
}

pub fn swap_failed(account_id: &AccountId, token_id: &AccountId, side: LockKind, refunded: u128) {
    emit(
        "swap_failed",
        json!({
            "account_id": account_id,
            "token_id": token_id,
            "side": side,
            "refunded": U128(refunded),
        }),
    );
}

/// Emitted when Rhea reports a swap as filled but the output never arrived in
/// this contract, meaning it is sitting in Rhea's internal ledger for us. The
/// user is made whole immediately and `sweep_rhea` recovers the funds.
pub fn shortfall(account_id: &AccountId, token_id: &AccountId, amount: u128, total: u128) {
    emit(
        "shortfall",
        json!({
            "account_id": account_id,
            "token_id": token_id,
            "amount": U128(amount),
            "total_shortfall": U128(total),
        }),
    );
}

pub fn token_listed(token_id: &AccountId, symbol: &str) {
    emit(
        "token_listed",
        json!({ "token_id": token_id, "symbol": symbol }),
    );
}

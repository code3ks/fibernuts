//! Conversion between ecash units and Fiber/UDT base units.
//!
//! A Cashu mint issues proofs in whole units and denominates them in powers of two, so the unit
//! must be coarse enough to keep keysets small. RUSD carries 8 decimals; fibernuts mints one
//! ecash unit per RUSD *cent*, i.e. `unit_scale = 1_000_000` base units per ecash unit.
//!
//! Rounding always favours the mint's solvency: amounts the mint *receives* round down, amounts
//! the mint *charges* round up. A mint that rounds a fee down eats the difference on every melt.

use crate::error::Error;

/// Scales an ecash amount up into the UDT's base units.
///
/// Infallible: the product of two `u64`s is always representable in a `u128`.
pub fn to_base(ecash: u64, scale: u64) -> u128 {
    ecash as u128 * scale as u128
}

/// Scales base units down into ecash, rounding **down**.
///
/// Used for funds arriving at the mint: never credit a wallet more than actually landed.
pub fn from_base_floor(base: u128, scale: u64) -> Result<u64, Error> {
    u64::try_from(base / scale as u128).map_err(|_| Error::AmountOverflow {
        amount: base,
        scale,
    })
}

/// Scales base units down into ecash, rounding **up**.
///
/// Used for anything the mint charges — melt amounts and fee reserves. Rounding down here would
/// let a wallet melt for less than the payment costs the mint.
pub fn from_base_ceil(base: u128, scale: u64) -> Result<u64, Error> {
    u64::try_from(base.div_ceil(scale as u128)).map_err(|_| Error::AmountOverflow {
        amount: base,
        scale,
    })
}

/// The fee the mint reserves for a melt, in ecash units.
///
/// Takes the routed fee the node quoted, applies a percentage cushion for route churn between
/// quote and pay, and enforces a floor so dust routes still reserve something.
pub fn fee_reserve(
    routed_fee_base: u128,
    scale: u64,
    percent: u8,
    floor: u64,
) -> Result<u64, Error> {
    let routed = from_base_ceil(routed_fee_base, scale)?;
    // `routed` is a u64 and `percent` at most 255, so the product cannot overflow a u128.
    let cushioned = (routed as u128 * (100 + percent as u128)).div_ceil(100);
    let cushioned = u64::try_from(cushioned).map_err(|_| Error::AmountOverflow {
        amount: cushioned,
        scale,
    })?;
    Ok(cushioned.max(floor))
}

/// The `max_fee_rate` (parts per thousand) needed for FNN to honour `max_fee_amount`.
///
/// FNN clamps the effective ceiling to `min(max_fee_amount, amount * max_fee_rate / 1000)` and
/// defaults the rate to 5 (0.5%). A reserve above 0.5% of the amount is therefore silently cut
/// unless the rate is raised to match, which makes the payment fail to route for a fee the mint
/// already quoted and collected. `None` means the default rate already admits the ceiling.
pub fn max_fee_rate_for(amount_base: u128, max_fee_base: u128) -> Option<u64> {
    const DEFAULT_RATE: u128 = 5;
    const DENOMINATOR: u128 = 1000;

    if amount_base == 0 {
        return None;
    }
    let needed = max_fee_base.checked_mul(DENOMINATOR)?.div_ceil(amount_base);
    if needed <= DEFAULT_RATE {
        return None;
    }
    u64::try_from(needed).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One ecash unit is one RUSD cent.
    const SCALE: u64 = 1_000_000;

    #[test]
    fn one_ecash_unit_is_one_rusd_cent() {
        assert_eq!(to_base(1, SCALE), 1_000_000);
        assert_eq!(to_base(100, SCALE), 100_000_000); // 100 cents == 1.00 RUSD
    }

    #[test]
    fn scaling_up_never_overflows_for_any_u64() {
        assert_eq!(to_base(u64::MAX, SCALE), u64::MAX as u128 * SCALE as u128);
        assert_eq!(
            to_base(u64::MAX, u64::MAX),
            u64::MAX as u128 * u64::MAX as u128
        );
    }

    #[test]
    fn scaling_round_trips_on_exact_multiples() {
        for ecash in [0u64, 1, 7, 100, 250_000] {
            let base = to_base(ecash, SCALE);
            assert_eq!(from_base_floor(base, SCALE).unwrap(), ecash);
            assert_eq!(from_base_ceil(base, SCALE).unwrap(), ecash);
        }
    }

    #[test]
    fn received_dust_rounds_down_so_the_mint_never_over_credits() {
        assert_eq!(from_base_floor(SCALE as u128 - 1, SCALE).unwrap(), 0);
        assert_eq!(from_base_floor(SCALE as u128 + 999, SCALE).unwrap(), 1);
    }

    #[test]
    fn charged_dust_rounds_up_so_the_mint_never_under_charges() {
        assert_eq!(from_base_ceil(1, SCALE).unwrap(), 1);
        assert_eq!(from_base_ceil(SCALE as u128 + 1, SCALE).unwrap(), 2);
        assert_eq!(from_base_ceil(0, SCALE).unwrap(), 0);
    }

    #[test]
    fn ceil_never_undershoots_floor() {
        for base in [
            0u128,
            1,
            SCALE as u128 - 1,
            SCALE as u128,
            SCALE as u128 * 3 + 7,
        ] {
            assert!(from_base_ceil(base, SCALE).unwrap() >= from_base_floor(base, SCALE).unwrap());
        }
    }

    #[test]
    fn scaling_down_past_u64_errors_rather_than_wrapping() {
        assert!(from_base_floor(u128::MAX, 1).is_err());
        assert!(from_base_ceil(u128::MAX, 1).is_err());
    }

    #[test]
    fn fee_reserve_applies_the_cushion_and_rounds_up() {
        // 3 ecash units of routed fee, +10% cushion => 3.3 => 4.
        assert_eq!(fee_reserve(to_base(3, SCALE), SCALE, 10, 0).unwrap(), 4);
    }

    #[test]
    fn fee_reserve_honours_the_floor_for_dust_routes() {
        assert_eq!(fee_reserve(0, SCALE, 10, 2).unwrap(), 2);
        assert_eq!(fee_reserve(1, SCALE, 0, 5).unwrap(), 5);
    }

    #[test]
    fn fee_reserve_is_never_below_the_routed_fee() {
        for routed_ecash in [1u64, 2, 9, 1000] {
            let routed = to_base(routed_ecash, SCALE);
            assert!(fee_reserve(routed, SCALE, 1, 0).unwrap() >= routed_ecash);
        }
    }

    #[test]
    fn fee_rate_stays_default_when_the_reserve_fits_under_half_a_percent() {
        // 0.5% of 1_000_000 is 5_000; a 1_000 reserve needs no override.
        assert_eq!(max_fee_rate_for(1_000_000, 1_000), None);
        assert_eq!(max_fee_rate_for(1_000_000, 5_000), None);
    }

    #[test]
    fn fee_rate_is_raised_when_the_reserve_exceeds_half_a_percent() {
        // 1% of the amount needs a rate of 10ppt, else FNN clamps the ceiling back to 0.5%.
        assert_eq!(max_fee_rate_for(1_000_000, 10_000), Some(10));
        // Rounds up: 5_001/1_000_000 needs 6ppt, not 5.
        assert_eq!(max_fee_rate_for(1_000_000, 5_001), Some(6));
    }

    #[test]
    fn a_raised_rate_always_admits_the_requested_ceiling() {
        // The whole point: amount * rate / 1000 >= max_fee, so FNN's min() picks max_fee.
        for (amount, fee) in [
            (1_000_000u128, 10_000u128),
            (7_777, 200),
            (1, 1),
            (3, 1_000),
        ] {
            if let Some(rate) = max_fee_rate_for(amount, fee) {
                assert!(
                    amount * rate as u128 / 1000 >= fee,
                    "amount={amount} fee={fee} rate={rate}"
                );
            }
        }
    }

    #[test]
    fn zero_amount_has_no_meaningful_fee_rate() {
        assert_eq!(max_fee_rate_for(0, 100), None);
    }
}

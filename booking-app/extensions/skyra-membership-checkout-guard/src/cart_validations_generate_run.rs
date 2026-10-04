use super::schema;
use shopify_function::prelude::*;
use shopify_function::scalars::JsonValue;
use shopify_function::Result;

const BLOCK_MESSAGE: &str = "This monthly Pass checkout could not be verified. Return to Membership or Booking, or contact the studio before paying.";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

// Trust comes from Shopify's app-owned resource permissions, not from secrecy
// of this payload. The app must refuse enablement while any public Storefront
// token for this same app exists. An app-owned namespace does not distinguish
// the app's public and private tokens. Never accept this grant from a browser.
struct Authorization<'a> {
    customer_gid: &'a str,
    product_gid: &'a str,
    variant_gid: &'a str,
    selling_plan_gid: Option<&'a str>,
    price_cents: u64,
}

fn json_string<'a>(
    fields: &'a std::collections::BTreeMap<String, JsonValue>,
    key: &str,
) -> Option<&'a str> {
    match fields.get(key)? {
        JsonValue::String(value) => Some(value.as_str()),
        _ => None,
    }
}

fn json_integer(value: &JsonValue) -> Option<u64> {
    match value {
        JsonValue::Number(number)
            if number.is_finite()
                && *number >= 0.0
                && *number <= MAX_SAFE_INTEGER as f64
                && number.fract() == 0.0 =>
        {
            Some(*number as u64)
        }
        _ => None,
    }
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn valid_gid(value: &str, owner: &str) -> bool {
    value
        .strip_prefix("gid://shopify/")
        .and_then(|rest| rest.strip_prefix(owner))
        .and_then(|rest| rest.strip_prefix('/'))
        .is_some_and(|id| {
            !id.is_empty() && id.len() <= 32 && id.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn authorization(value: &JsonValue) -> Option<Authorization<'_>> {
    let JsonValue::Object(fields) = value else {
        return None;
    };
    // An exact protocol prevents unsupported fields/versions from silently
    // receiving permission. CLOSED grants and malformed grants always reject.
    if fields.len() != 12
        || json_integer(fields.get("version")?) != Some(1)
        || json_string(fields, "state")? != "OPEN"
        || json_integer(fields.get("cycle")?)? == 0
        || json_string(fields, "currency")? != "AUD"
        || !valid_uuid(json_string(fields, "purchaseId")?)
        || !valid_uuid(json_string(fields, "membershipId")?)
    {
        return None;
    }
    let nonce = json_string(fields, "nonce")?;
    if nonce.len() != 43
        || !nonce
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    let customer_gid = json_string(fields, "customerGid")?;
    let product_gid = json_string(fields, "productGid")?;
    let variant_gid = json_string(fields, "variantGid")?;
    let selling_plan_gid = match fields.get("sellingPlanGid")? {
        JsonValue::Null => None,
        JsonValue::String(value) if valid_gid(value, "SellingPlan") => Some(value.as_str()),
        _ => return None,
    };
    if !valid_gid(customer_gid, "Customer")
        || !valid_gid(product_gid, "Product")
        || !valid_gid(variant_gid, "ProductVariant")
    {
        return None;
    }
    Some(Authorization {
        customer_gid,
        product_gid,
        variant_gid,
        selling_plan_gid,
        price_cents: json_integer(fields.get("priceCents")?)?,
    })
}

// Decimal amounts are checked as cents without rounding or a floating-point
// epsilon. Additional trailing zeroes are allowed; fractional cents are not.
fn money_cents(value: &str) -> Option<u64> {
    let (whole, fractional) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fractional.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let bytes = fractional.as_bytes();
    if bytes.iter().skip(2).any(|byte| *byte != b'0') {
        return None;
    }
    let decimal_cents = u64::from(bytes.first().map_or(0, |byte| byte - b'0')) * 10
        + u64::from(bytes.get(1).map_or(0, |byte| byte - b'0'));
    whole
        .parse::<u64>()
        .ok()?
        .checked_mul(100)?
        .checked_add(decimal_cents)
        .filter(|cents| *cents <= MAX_SAFE_INTEGER)
}

fn allowed() -> schema::CartValidationsGenerateRunResult {
    schema::CartValidationsGenerateRunResult { operations: vec![] }
}

fn blocked() -> schema::CartValidationsGenerateRunResult {
    schema::CartValidationsGenerateRunResult {
        operations: vec![schema::Operation::ValidationAdd(
            schema::ValidationAddOperation {
                errors: vec![schema::ValidationError {
                    message: BLOCK_MESSAGE.to_owned(),
                    target: "$.cart".to_owned(),
                }],
            },
        )],
    }
}

#[shopify_function]
fn cart_validations_generate_run(
    input: schema::cart_validations_generate_run::Input,
) -> Result<schema::CartValidationsGenerateRunResult> {
    let cart = input.cart();
    let protected = cart.authorization().is_some()
        || cart.lines().iter().any(|line| {
            match line.merchandise() {
            schema::cart_validations_generate_run::input::cart::lines::Merchandise::ProductVariant(
                variant,
            ) => variant
                .product()
                .managed_monthly_pass()
                // A present but malformed marker must never turn protection off.
                .as_ref()
                .is_some_and(|marker| marker.json_value() != &JsonValue::Boolean(false)),
            _ => false,
        }
        });
    if !protected {
        return Ok(allowed());
    }

    // Buyers must be able to create the server cart and log in at checkout.
    // Every actual completion is checked, including accelerated checkout.
    match input.buyer_journey().step() {
        Some(schema::BuyerJourneyStep::CartInteraction)
        | Some(schema::BuyerJourneyStep::CheckoutInteraction) => return Ok(allowed()),
        Some(schema::BuyerJourneyStep::CheckoutCompletion) => {}
        _ => return Ok(blocked()),
    }

    let Some(cart_grant) = cart.authorization() else {
        return Ok(blocked());
    };
    let Some(grant) = authorization(cart_grant.json_value()) else {
        return Ok(blocked());
    };
    let Some(buyer) = cart.buyer_identity() else {
        return Ok(blocked());
    };
    let Some(customer) = buyer.customer() else {
        return Ok(blocked());
    };
    let Some(customer_grant) = customer.authorization() else {
        return Ok(blocked());
    };
    if !*buyer.is_authenticated()
        || customer.id() != grant.customer_gid
        || customer_grant.json_value() != cart_grant.json_value()
        || cart.lines().len() != 1
    {
        return Ok(blocked());
    }

    let line = &cart.lines()[0];
    let variant = match line.merchandise() {
        schema::cart_validations_generate_run::input::cart::lines::Merchandise::ProductVariant(
            variant,
        ) => variant,
        _ => return Ok(blocked()),
    };
    let plan_gid = line
        .selling_plan_allocation()
        .as_ref()
        .map(|allocation| allocation.selling_plan().id().as_str());
    let line_amount = line.cost().total_amount();
    let original_amount = line.cost().subtotal_amount();
    let cart_amount = cart.cost().total_amount();
    if *line.quantity() != 1
        || variant.id() != grant.variant_gid
        || variant.product().id() != grant.product_gid
        || plan_gid != grant.selling_plan_gid
        || line_amount.currency_code() != "AUD"
        || cart_amount.currency_code() != "AUD"
        || original_amount.currency_code() != "AUD"
        || money_cents(original_amount.amount()) != Some(grant.price_cents)
        || !money_cents(line_amount.amount()).is_some_and(|paid| paid <= grant.price_cents)
        || money_cents(cart_amount.amount()) != money_cents(line_amount.amount())
        || !variant
            .product()
            .managed_monthly_pass()
            .as_ref()
            .is_some_and(|marker| marker.json_value() == &JsonValue::Boolean(true))
    {
        return Ok(blocked());
    }
    Ok(allowed())
}

#[cfg(test)]
mod tests {
    use super::*;
    use shopify_function::{run_function_with_input, Result};

    const VALID: &str = include_str!("../tests/inputs/authorized-once.json");

    fn accepted(input: &str) -> Result<()> {
        assert_eq!(
            run_function_with_input(cart_validations_generate_run, input)?,
            allowed()
        );
        Ok(())
    }

    fn rejected(input: &str) -> Result<()> {
        assert_eq!(
            run_function_with_input(cart_validations_generate_run, input)?,
            blocked()
        );
        Ok(())
    }

    #[test]
    fn authorized_monthly_once() -> Result<()> {
        accepted(VALID)
    }

    #[test]
    fn authorized_monthly_subscription() -> Result<()> {
        accepted(include_str!("../tests/inputs/authorized-subscription.json"))
    }

    #[test]
    fn first_checkout_accepts_shopify_free_discount_with_original_price_intact() -> Result<()> {
        accepted(include_str!("../tests/inputs/authorized-free.json"))
    }

    #[test]
    fn public_reference_does_not_authorize_another_cart() -> Result<()> {
        rejected(include_str!("../tests/inputs/copied-reference.json"))
    }

    #[test]
    fn old_cart_grant_is_not_the_current_customer_grant() -> Result<()> {
        rejected(&VALID.replacen("\"cycle\": 1", "\"cycle\": 2", 1))
    }

    #[test]
    fn another_open_grant_cannot_reauthorize_an_old_cart() -> Result<()> {
        rejected(&VALID.replacen(
            "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
            "Zbcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
            1,
        ))
    }

    #[test]
    fn missing_customer_grant_cannot_authorize_payment() -> Result<()> {
        rejected(include_str!("../tests/inputs/missing-customer-grant.json"))
    }

    #[test]
    fn malformed_grant_returns_a_normal_blocking_error() -> Result<()> {
        rejected(include_str!("../tests/inputs/malformed-grant.json"))
    }

    #[test]
    fn closed_customer_grant_rejects_the_old_link() -> Result<()> {
        rejected(&VALID.replacen("\"state\": \"OPEN\"", "\"state\": \"CLOSED\"", 1))
    }

    #[test]
    fn closed_identical_grants_are_not_authorization() -> Result<()> {
        rejected(&VALID.replace("\"state\": \"OPEN\"", "\"state\": \"CLOSED\""))
    }

    #[test]
    fn guest_checkout_cannot_pay() -> Result<()> {
        rejected(&VALID.replace("\"isAuthenticated\": true", "\"isAuthenticated\": false"))
    }

    #[test]
    fn switched_customer_cannot_pay() -> Result<()> {
        rejected(&VALID.replace(
            "\"id\": \"gid://shopify/Customer/101\"",
            "\"id\": \"gid://shopify/Customer/999\"",
        ))
    }

    #[test]
    fn cart_and_checkout_interaction_allow_login_before_completion() -> Result<()> {
        accepted(
            &VALID
                .replace("CHECKOUT_COMPLETION", "CART_INTERACTION")
                .replace("\"isAuthenticated\": true", "\"isAuthenticated\": false"),
        )?;
        accepted(
            &VALID
                .replace("CHECKOUT_COMPLETION", "CHECKOUT_INTERACTION")
                .replace("\"isAuthenticated\": true", "\"isAuthenticated\": false"),
        )
    }

    #[test]
    fn missing_journey_context_cannot_authorize_a_protected_cart() -> Result<()> {
        rejected(&VALID.replace("\"step\": \"CHECKOUT_COMPLETION\"", "\"step\": null"))
    }

    #[test]
    fn duplicate_quantity_is_rejected() -> Result<()> {
        rejected(&VALID.replace("\"quantity\": 1", "\"quantity\": 2"))
    }

    #[test]
    fn mixed_cart_is_rejected() -> Result<()> {
        rejected(include_str!("../tests/inputs/mixed-cart.json"))
    }

    #[test]
    fn changed_variant_and_product_are_rejected() -> Result<()> {
        rejected(&VALID.replace(
            "\"id\": \"gid://shopify/ProductVariant/201\"",
            "\"id\": \"gid://shopify/ProductVariant/202\"",
        ))?;
        rejected(&VALID.replace(
            "\"id\": \"gid://shopify/Product/301\"",
            "\"id\": \"gid://shopify/Product/302\"",
        ))
    }

    #[test]
    fn unauthorized_selling_plan_is_rejected() -> Result<()> {
        rejected(&VALID.replace("\"sellingPlanAllocation\": null", "\"sellingPlanAllocation\": {\"sellingPlan\": {\"id\": \"gid://shopify/SellingPlan/401\"}}"))?;
        rejected(
            &include_str!("../tests/inputs/authorized-subscription.json").replacen(
                "\"id\": \"gid://shopify/SellingPlan/401\"",
                "\"id\": \"gid://shopify/SellingPlan/402\"",
                1,
            ),
        )
    }

    #[test]
    fn changed_line_price_or_checkout_total_is_rejected() -> Result<()> {
        rejected(&VALID.replacen("\"amount\": \"299.00\"", "\"amount\": \"300.00\"", 1))?;
        let mut changed_line = VALID.to_owned();
        let original = "\"amount\": \"299.00\"";
        let index = changed_line
            .rfind(original)
            .expect("fixture has a line amount");
        changed_line.replace_range(index..index + original.len(), "\"amount\": \"300.00\"");
        rejected(&changed_line)?;
        rejected(&VALID.replace("\"amount\": \"299.00\"", "\"amount\": \"300.00\""))?;
        rejected(&VALID.replace("\"amount\": \"299.00\"", "\"amount\": \"299.001\""))
    }

    #[test]
    fn sub_cent_wire_amount_is_not_rounded_by_the_sdk() -> Result<()> {
        rejected(&VALID.replace(
            "\"amount\": \"299.00\"",
            "\"amount\": \"299.0000000000000001\"",
        ))
    }

    #[test]
    fn changed_currency_is_rejected() -> Result<()> {
        rejected(&VALID.replace("\"currencyCode\": \"AUD\"", "\"currencyCode\": \"USD\""))
    }

    #[test]
    fn malformed_and_unsupported_identical_grants_are_rejected() -> Result<()> {
        rejected(&VALID.replace("\"version\": 1", "\"version\": 2"))?;
        rejected(&VALID.replace("\"cycle\": 1", "\"cycle\": 0"))?;
        rejected(&VALID.replace("\"priceCents\": 29900", "\"priceCents\": 29900.5"))?;
        rejected(&VALID.replace("\"priceCents\": 29900", "\"priceCents\": \"29900\""))?;
        rejected(&VALID.replace("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", "too-short"))?;
        rejected(&VALID.replace("\"nonce\":", "\"unexpected\": true, \"nonce\":"))
    }

    #[test]
    fn malformed_marker_cannot_disable_protection() -> Result<()> {
        rejected(&VALID.replace("\"jsonValue\": true", "\"jsonValue\": \"true\""))?;
        rejected(include_str!("../tests/inputs/malformed-marker.json"))
    }

    #[test]
    fn authorization_presence_protects_a_cart_whose_product_was_changed() -> Result<()> {
        rejected(&VALID.replace("\"jsonValue\": true", "\"jsonValue\": false"))
    }

    #[test]
    fn ordinary_unprotected_carts_are_untouched() -> Result<()> {
        accepted(include_str!("../tests/inputs/unprotected-cart.json"))
    }

    #[test]
    fn cents_are_not_rounded() {
        assert_eq!(money_cents("299"), Some(29900));
        assert_eq!(money_cents("299.0"), Some(29900));
        assert_eq!(money_cents("299.0000"), Some(29900));
        assert_eq!(money_cents("0.01"), Some(1));
        assert_eq!(money_cents("299.001"), None);
        assert_eq!(money_cents("-299.00"), None);
        assert_eq!(money_cents("1e3"), None);
        assert_eq!(money_cents("90071992547409.92"), None);
    }
}

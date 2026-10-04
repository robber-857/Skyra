use shopify_function::prelude::*;
use std::process;

pub mod cart_validations_generate_run;

#[typegen("schema.graphql")]
pub mod schema {
    // Shopify's standard Decimal wrapper uses f64. Keep the wire strings so
    // checkout amounts are compared as exact cents before any numeric rounding.
    #[query("src/cart_validations_generate_run.graphql", custom_scalar_overrides = {
        "Input.cart.cost.totalAmount.amount" => ::std::string::String,
        "Input.cart.lines.cost.totalAmount.amount" => ::std::string::String,
        "Input.cart.lines.cost.subtotalAmount.amount" => ::std::string::String,
    })]
    pub mod cart_validations_generate_run {}
}

fn main() {
    log!("Please invoke a named export.");
    process::abort();
}

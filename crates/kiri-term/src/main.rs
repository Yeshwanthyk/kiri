use std::io::{self, Read};

use anyhow::{Context, Result};
use kiri_term::TerminalDocument;

fn main() -> Result<()> {
    let mut cols = 80usize;
    let mut rows = 24usize;
    let raw_args = std::env::args().skip(1).collect::<Vec<_>>();
    if matches!(raw_args.first().map(String::as_str), Some("serve")) {
        return kiri_term::sidecar::run_stdio();
    }
    let mut args = raw_args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--cols" => {
                cols = args
                    .next()
                    .context("missing --cols value")?
                    .parse()
                    .context("invalid --cols value")?;
            }
            "--rows" => {
                rows = args
                    .next()
                    .context("missing --rows value")?
                    .parse()
                    .context("invalid --rows value")?;
            }
            "--help" | "-h" => {
                println!("usage: kiri-term [--cols N] [--rows N] < input");
                return Ok(());
            }
            other => anyhow::bail!("unknown argument: {other}"),
        }
    }

    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input)?;
    let mut document = TerminalDocument::new(cols, rows);
    document.apply_bytes(&input);
    println!("{}", serde_json::to_string_pretty(&document.snapshot())?);
    Ok(())
}

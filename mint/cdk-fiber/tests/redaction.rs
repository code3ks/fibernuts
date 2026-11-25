use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use cdk_fiber::journal::JournalError;
use cdk_fiber::wire::{PaymentResult, PaymentStatus, SendPaymentParams};
use cdk_fiber::{Error, HttpFiberRpc};
use tracing_subscriber::fmt::MakeWriter;

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

impl Write for CaptureWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for Capture {
    type Writer = CaptureWriter;

    fn make_writer(&'a self) -> Self::Writer {
        CaptureWriter(self.0.clone())
    }
}

impl Capture {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
}

#[test]
fn tracing_error_and_debug_output_redact_all_canaries() {
    let invoice = format!("fibt1{}", "invoicecanary".repeat(8));
    let payment_hash = format!("0x{}", "11".repeat(32));
    let preimage = format!("0x{}", "22".repeat(32));
    let signing_key = "33".repeat(32);
    let proof_secret = "synthetic-proof-secret";
    let capability = "synthetic-capability-never-log";
    let node_detail = format!(
        "cashuBsyntheticBearerCanary quotePrivateKey={signing_key} proofSecret={proof_secret} readCapability={capability} user@example.test"
    );
    let rpc_password = "synthetic-rpc-password";

    let error = Error::Rpc {
        code: -32_000,
        message: node_detail.clone(),
    };
    let journal_error = JournalError::Io(io::Error::other(node_detail.clone()));
    assert!(std::error::Error::source(&journal_error).is_none());
    let payment = PaymentResult {
        payment_hash: payment_hash.clone(),
        payment_preimage: Some(preimage.clone()),
        status: PaymentStatus::Failed,
        fee: 0,
        failed_error: Some(node_detail.clone()),
    };
    let request = SendPaymentParams {
        invoice: invoice.clone(),
        max_fee_amount: Some(10),
        max_fee_rate: Some(10),
        dry_run: Some(false),
    };
    let rpc = HttpFiberRpc::new(format!("http://operator:{rpc_password}@127.0.0.1:1")).unwrap();

    let capture = Capture::default();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_target(false)
        .with_writer(capture.clone())
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        tracing::error!(
            error = %error,
            error_debug = ?error,
            payment = ?payment,
            request = ?request,
            rpc = ?rpc,
            journal_error = ?journal_error,
            "synthetic redaction exercise"
        );
    });

    let output = capture.text();
    for canary in [
        invoice.as_str(),
        payment_hash.as_str(),
        preimage.as_str(),
        node_detail.as_str(),
        signing_key.as_str(),
        proof_secret,
        capability,
        rpc_password,
    ] {
        assert!(
            !output.contains(canary),
            "diagnostic output exposed a canary"
        );
    }
    assert!(output.contains("[REDACTED]"));
}

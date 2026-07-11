CARGO = cd mint && cargo
NPM   = npm --prefix wallet

.PHONY: setup build test lint fmt fmt-check ci clean wallet wallet-build

setup:
	rustup component add rustfmt clippy
	@command -v protoc >/dev/null || (echo "protoc is required (brew install protobuf)" && exit 1)

build:
	$(CARGO) build --all-targets

test:
	$(CARGO) test

lint:
	$(CARGO) clippy --all-targets -- -D warnings

fmt:
	$(CARGO) fmt --all

fmt-check:
	$(CARGO) fmt --all -- --check

wallet:
	$(NPM) run dev

wallet-build:
	$(NPM) ci && $(NPM) run build

ci: fmt-check lint test build

clean:
	$(CARGO) clean
	rm -rf wallet/dist wallet/node_modules

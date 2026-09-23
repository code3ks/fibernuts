CARGO      = cd mint && cargo
WALLET_NPM = npm --prefix wallet
MARKET_NPM = npm --prefix market
RELAY_NPM  = npm --prefix relay

.PHONY: setup build test lint fmt fmt-check mint-ci wallet wallet-build wallet-ci relay-ci market-ci ci clean

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
	$(WALLET_NPM) run dev

wallet-build:
	$(WALLET_NPM) ci && $(WALLET_NPM) run build

mint-ci: fmt-check lint test build

wallet-ci:
	$(WALLET_NPM) test -- --run
	$(WALLET_NPM) run typecheck
	$(WALLET_NPM) run build
	$(WALLET_NPM) run test:e2e

relay-ci:
	$(RELAY_NPM) test
	$(RELAY_NPM) run typecheck

market-ci:
	$(MARKET_NPM) test -- --run
	$(MARKET_NPM) run typecheck
	$(MARKET_NPM) run build
	$(MARKET_NPM) run test:e2e

ci: mint-ci wallet-ci relay-ci market-ci

clean:
	$(CARGO) clean
	rm -rf wallet/dist wallet/node_modules

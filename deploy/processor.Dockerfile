# fibernuts-processor — the cdk-fiber gRPC payment backend.
# Build context is the repo's `mint/` workspace.
#
#   docker build -f deploy/processor.Dockerfile -t fibernuts-processor mint/

FROM rust:1.88-slim-bookworm AS build
# cdk-payment-processor compiles its .proto at build time, so protoc is required.
RUN apt-get update \
    && apt-get install -y --no-install-recommends protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY . .
RUN cargo build --release -p fibernuts-processor \
    && strip target/release/fibernuts-processor

FROM debian:bookworm-slim
# reqwest uses rustls, so only CA certificates are needed at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home --uid 10001 fibernuts
COPY --from=build /build/target/release/fibernuts-processor /usr/local/bin/fibernuts-processor
USER fibernuts
ENTRYPOINT ["fibernuts-processor"]

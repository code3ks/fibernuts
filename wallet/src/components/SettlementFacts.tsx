import {
  legacySettlementContext,
  metadataSourceLabel,
  type SettlementContext,
} from "../domain/settlement-context";

function Source({ context }: { context: { source: Parameters<typeof metadataSourceLabel>[0] } }) {
  return <span className="fact-source">Source: {metadataSourceLabel(context.source)}</span>;
}

export function SettlementFacts({
  context,
  mintUrl,
  unit,
  title = "Settlement identity",
}: {
  context?: SettlementContext;
  mintUrl: string;
  unit: string;
  title?: string;
}) {
  const facts = context ?? legacySettlementContext(mintUrl, unit);
  const asset = facts.assetTypeScript;

  return (
    <div className="settlement-facts">
      <h3>{title}</h3>
      <dl className="detail-list">
        <div>
          <dt>Issuing mint</dt>
          <dd>{facts.mintName.value}<Source context={facts.mintName} /></dd>
        </div>
        <div>
          <dt>Mint URL</dt>
          <dd className="mono settlement-facts__value">{mintUrl}</dd>
        </div>
        <div>
          <dt>Unit</dt>
          <dd>{facts.unit.value}<Source context={facts.unit} /></dd>
        </div>
        <div>
          <dt>Settlement method</dt>
          <dd>{facts.paymentMethod.value}<Source context={facts.paymentMethod} /></dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>
            {facts.network?.value ?? "Not declared for this mint"}
            {facts.network ? <Source context={facts.network} /> : <span className="fact-source">No operator declaration</span>}
          </dd>
        </div>
        <div>
          <dt>Asset type script</dt>
          <dd>
            {asset ? (
              <span className="settlement-script mono">
                <span><b>code_hash</b>{asset.value.codeHash}</span>
                <span><b>hash_type</b>{asset.value.hashType}</span>
                <span><b>args</b>{asset.value.args}</span>
              </span>
            ) : "Not declared for this mint"}
            {asset ? <Source context={asset} /> : <span className="fact-source">No operator declaration</span>}
          </dd>
        </div>
      </dl>
    </div>
  );
}

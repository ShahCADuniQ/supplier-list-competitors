"use client";

import { useMemo, useState } from "react";
import {
  aiBenchmarkCollection,
  type BenchmarkSummary,
} from "./ai-ideation-actions";
import ProductDetailDrawer from "./ProductDetailDrawer";
import type {
  CompetitorCollection,
  Competitor,
  CompetitorAttachment,
  CompetitorProduct,
  CompetitorProductAttachment,
} from "@/db/schema";

type FullCompetitorProduct = CompetitorProduct & {
  attachments: CompetitorProductAttachment[];
};
type FullCompetitor = Competitor & {
  attachments: CompetitorAttachment[];
  products: FullCompetitorProduct[];
};

type ProductRef = { id: number; name: string; brandName: string };

type StatRow = {
  value: string;
  count: number;
  productRefs: ProductRef[];
};

/**
 * Tally a list of (value, productRef) tuples into stat rows. Normalizes case
 * so "Surface" / "surface" / "SURFACE" merge into one row, and tracks which
 * products contributed to each row so the UI can drill in.
 */
function tallyWithRefs(
  pairs: Array<{ value: string; productRef: ProductRef }>,
): StatRow[] {
  const counts = new Map<string, StatRow>();
  const addedRef = new Map<string, Set<number>>();
  for (const { value, productRef } of pairs) {
    const t = value.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    const ex = counts.get(key);
    let refSet = addedRef.get(key);
    if (!refSet) {
      refSet = new Set<number>();
      addedRef.set(key, refSet);
    }
    if (ex) {
      ex.count += 1;
      if (!refSet.has(productRef.id)) {
        ex.productRefs.push(productRef);
        refSet.add(productRef.id);
      }
    } else {
      counts.set(key, {
        value: t,
        count: 1,
        productRefs: [productRef],
      });
      refSet.add(productRef.id);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

function pickSpec(p: CompetitorProduct, key: string): string[] {
  const v = p.specs?.[key];
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(/[,;|\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export default function SummaryView({
  collection,
  brands,
  canEdit,
  onToast,
}: {
  collection: CompetitorCollection;
  brands: FullCompetitor[];
  canEdit: boolean;
  onToast: (msg: string, err?: boolean) => void;
}) {
  const products = useMemo(() => brands.flatMap((b) => b.products), [brands]);
  // Selected product → opens the drawer (clicked from card grid OR drilldown).
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);
  const productById = useMemo(() => {
    const m = new Map<number, { product: FullCompetitorProduct; brandName: string }>();
    for (const b of brands) {
      for (const p of b.products) m.set(p.id, { product: p, brandName: b.name });
    }
    return m;
  }, [brands]);
  const selected = selectedProductId !== null ? productById.get(selectedProductId) : null;

  // Build a brand-id → name map so we can label products with their brand.
  const brandNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const b of brands) m.set(b.id, b.name);
    return m;
  }, [brands]);

  // Auto-tallied "market standard" stats with product-ref tracking so each
  // value is clickable to drill into the contributing products.
  const stats = useMemo(() => {
    type Pairs = Array<{ value: string; productRef: ProductRef }>;
    const make = (): Pairs => [];
    const buckets = {
      mounting: make(),
      lensType: make(),
      orientation: make(),
      driverLocation: make(),
      dimming: make(),
      customization: make(),
      accessories: make(),
      finishes: make(),
      colors: make(),
      ip: make(),
      cct: make(),
      wattage: make(),
      lumens: make(),
      cri: make(),
      beam: make(),
      voltage: make(),
      certs: make(),
      categories: make(),
      efficacy: make(),
      maxLengths: make(),
      lengths: make(),
      profileFaceSizes: make(),
      cutouts: make(),
      r9s: make(),
      sdcms: make(),
      ugrs: make(),
      lifespans: make(),
      housings: make(),
      origins: make(),
      operatingTemps: make(),
      warranties: make(),
    };
    for (const p of products) {
      const productRef: ProductRef = {
        id: p.id,
        name: p.name,
        brandName: brandNameById.get(p.competitorId) ?? "",
      };
      const push = (bucket: Pairs, vals: string[]) => {
        for (const v of vals) bucket.push({ value: v, productRef });
      };
      push(buckets.mounting, pickSpec(p, "mounting"));
      push(buckets.lensType, pickSpec(p, "lensType"));
      push(buckets.orientation, pickSpec(p, "orientation"));
      push(buckets.driverLocation, pickSpec(p, "driverLocation"));
      push(buckets.dimming, pickSpec(p, "dimming"));
      push(buckets.customization, pickSpec(p, "customization"));
      push(buckets.accessories, pickSpec(p, "accessories"));
      push(buckets.finishes, pickSpec(p, "finishes"));
      push(buckets.colors, pickSpec(p, "colors"));
      push(buckets.ip, pickSpec(p, "ipRating"));
      push(buckets.cct, pickSpec(p, "cct"));
      push(buckets.wattage, pickSpec(p, "wattage"));
      push(buckets.lumens, pickSpec(p, "lumens"));
      push(buckets.cri, pickSpec(p, "cri"));
      push(buckets.beam, pickSpec(p, "beamAngle"));
      push(buckets.voltage, pickSpec(p, "voltage"));
      push(buckets.certs, pickSpec(p, "certifications"));
      push(buckets.efficacy, pickSpec(p, "efficacy"));
      push(buckets.maxLengths, pickSpec(p, "maxLength"));
      push(buckets.lengths, pickSpec(p, "length"));
      push(buckets.profileFaceSizes, pickSpec(p, "profileFaceSize"));
      push(buckets.cutouts, pickSpec(p, "cutout"));
      push(buckets.r9s, pickSpec(p, "r9"));
      push(buckets.sdcms, pickSpec(p, "sdcm"));
      push(buckets.ugrs, pickSpec(p, "ugr"));
      push(buckets.lifespans, pickSpec(p, "lifespan"));
      push(buckets.housings, pickSpec(p, "housingMaterial"));
      push(buckets.origins, pickSpec(p, "countryOfOrigin"));
      push(buckets.operatingTemps, pickSpec(p, "operatingTemp"));
      push(buckets.warranties, pickSpec(p, "warranty"));
      if (p.productCategory) {
        buckets.categories.push({ value: p.productCategory, productRef });
      }
    }
    return {
      mounting: tallyWithRefs(buckets.mounting),
      lensType: tallyWithRefs(buckets.lensType),
      orientation: tallyWithRefs(buckets.orientation),
      driverLocation: tallyWithRefs(buckets.driverLocation),
      dimming: tallyWithRefs(buckets.dimming),
      customization: tallyWithRefs(buckets.customization),
      accessories: tallyWithRefs(buckets.accessories),
      finishes: tallyWithRefs(buckets.finishes),
      colors: tallyWithRefs(buckets.colors),
      ip: tallyWithRefs(buckets.ip),
      cct: tallyWithRefs(buckets.cct),
      wattage: tallyWithRefs(buckets.wattage),
      lumens: tallyWithRefs(buckets.lumens),
      cri: tallyWithRefs(buckets.cri),
      beam: tallyWithRefs(buckets.beam),
      voltage: tallyWithRefs(buckets.voltage),
      certs: tallyWithRefs(buckets.certs),
      categories: tallyWithRefs(buckets.categories),
      efficacy: tallyWithRefs(buckets.efficacy),
      maxLengths: tallyWithRefs(buckets.maxLengths),
      lengths: tallyWithRefs(buckets.lengths),
      profileFaceSizes: tallyWithRefs(buckets.profileFaceSizes),
      cutouts: tallyWithRefs(buckets.cutouts),
      r9s: tallyWithRefs(buckets.r9s),
      sdcms: tallyWithRefs(buckets.sdcms),
      ugrs: tallyWithRefs(buckets.ugrs),
      lifespans: tallyWithRefs(buckets.lifespans),
      housings: tallyWithRefs(buckets.housings),
      origins: tallyWithRefs(buckets.origins),
      operatingTemps: tallyWithRefs(buckets.operatingTemps),
      warranties: tallyWithRefs(buckets.warranties),
    };
  }, [products, brandNameById]);

  // ── Active drill-down: which (cardTitle, value) the user clicked on ──
  const [drillDown, setDrillDown] = useState<{
    cardTitle: string;
    row: StatRow;
  } | null>(null);

  // Top brands by product count, useful when you've populated dozens of brands.
  const topBrands = useMemo(() => {
    return [...brands]
      .map((b) => ({ name: b.name, count: b.products.length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [brands]);

  // ── AI summary state ──
  const [aiSummary, setAiSummary] = useState<BenchmarkSummary | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  async function runAi() {
    if (!products.length) {
      onToast("Add some competitor products first", true);
      return;
    }
    setAiBusy(true);
    try {
      const r = await aiBenchmarkCollection({ collectionId: collection.id });
      setAiSummary(r);
      onToast("Summary generated");
    } catch (e) {
      onToast(e instanceof Error ? e.message : "AI failed", true);
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <div className="bm-wrap">
      <div className="bm-head">
        <div>
          <div className="d-eyebrow">Summary</div>
          <h1 className="d-title">{collection.name}</h1>
          <p className="d-sub">
            What's common across {brands.length} brand{brands.length === 1 ? "" : "s"} ·{" "}
            {products.length} product{products.length === 1 ? "" : "s"}. Updates live as brands or products are added.
          </p>
        </div>
        <div className="d-actions">
          <button
            className="btn primary sm"
            onClick={runAi}
            disabled={aiBusy || !products.length}
          >
            {aiBusy ? "Analyzing…" : "✨ AI insights"}
          </button>
        </div>
      </div>

      {products.length > 0 && (
        <section className="sv-products">
          <div className="sv-products-head">
            <h3 className="sv-section-h">All products</h3>
            <span className="sv-products-count">
              {products.length} across {brands.length} brand
              {brands.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="sv-product-grid">
            {brands.flatMap((b) =>
              b.products.map((p) => {
                const firstImage = p.imageUrls?.[0];
                const photoCount = p.imageUrls?.length ?? 0;
                const fileCount = p.attachments.length;
                const face = (() => {
                  const v = p.specs?.profileFaceSize;
                  if (Array.isArray(v)) return v.filter(Boolean).join(", ");
                  return (v ?? "").toString().trim();
                })();
                const length = (() => {
                  const v = p.specs?.length;
                  if (Array.isArray(v)) return v.filter(Boolean).join(", ");
                  return (v ?? "").toString().trim();
                })();
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="sv-product-card"
                    onClick={() => setSelectedProductId(p.id)}
                  >
                    <div className="sv-product-thumb">
                      {firstImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={firstImage}
                          alt={p.name}
                          loading="lazy"
                          onError={(e) => {
                            (e.currentTarget.style.display = "none");
                          }}
                        />
                      ) : (
                        <div className="sv-product-thumb-empty">📷</div>
                      )}
                    </div>
                    <div className="sv-product-info">
                      <div className="sv-product-brand">{b.name}</div>
                      <div className="sv-product-name">{p.name}</div>
                      {p.productCode && (
                        <div className="sv-product-code">{p.productCode}</div>
                      )}
                      {(face || length) && (
                        <div className="sv-product-key">
                          {face && (
                            <span className="sv-product-key-row">
                              <strong>Face:</strong> {face}
                            </span>
                          )}
                          {length && (
                            <span className="sv-product-key-row">
                              <strong>Length:</strong> {length}
                            </span>
                          )}
                        </div>
                      )}
                      {(photoCount > 1 || fileCount > 0) && (
                        <div className="sv-product-counts">
                          {photoCount > 1 && (
                            <span className="sv-product-count">
                              📷 {photoCount}
                            </span>
                          )}
                          {fileCount > 0 && (
                            <span className="sv-product-count">
                              📎 {fileCount}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </button>
                );
              }),
            )}
          </div>
        </section>
      )}

      <div className="bm-grid">
        <StatCard title="Profile face" rows={stats.profileFaceSizes} empty="No profile face size data yet — attach a spec PDF and click Refresh from files." onPick={(row) => setDrillDown({ cardTitle: "Profile face", row })} />
        <StatCard title="Length" rows={stats.lengths} empty="No length data yet." onPick={(row) => setDrillDown({ cardTitle: "Length", row })} />
        <StatCard title="Cut-out" rows={stats.cutouts} empty="No cut-out data yet." onPick={(row) => setDrillDown({ cardTitle: "Cut-out", row })} />
        <StatCard title="UGR (glare)" rows={stats.ugrs} empty="No UGR data yet." onPick={(row) => setDrillDown({ cardTitle: "UGR (glare)", row })} />
        <StatCard title="R9" rows={stats.r9s} empty="No R9 data yet." onPick={(row) => setDrillDown({ cardTitle: "R9", row })} />
        <StatCard title="SDCM" rows={stats.sdcms} empty="No colour-consistency data yet." onPick={(row) => setDrillDown({ cardTitle: "SDCM", row })} />
        <StatCard title="Lifespan" rows={stats.lifespans} empty="No lifespan data yet." onPick={(row) => setDrillDown({ cardTitle: "Lifespan", row })} />
        <StatCard title="Operating temp" rows={stats.operatingTemps} empty="No operating-temp data yet." onPick={(row) => setDrillDown({ cardTitle: "Operating temp", row })} />
        <StatCard title="Housing material" rows={stats.housings} empty="No housing-material data yet." onPick={(row) => setDrillDown({ cardTitle: "Housing material", row })} />
        <StatCard title="Country of origin" rows={stats.origins} empty="No country-of-origin data yet." onPick={(row) => setDrillDown({ cardTitle: "Country of origin", row })} />
        <StatCard title="Warranty" rows={stats.warranties} empty="No warranty data yet." onPick={(row) => setDrillDown({ cardTitle: "Warranty", row })} />
        <StatCard title="Mounting" rows={stats.mounting} empty="Mounting not yet extracted on any product." onPick={(row) => setDrillDown({ cardTitle: "Mounting", row })} />
        <StatCard title="Lens / Optic" rows={stats.lensType} empty="Lens type not yet extracted on any product." onPick={(row) => setDrillDown({ cardTitle: "Lens / Optic", row })} />
        <StatCard title="Orientation" rows={stats.orientation} empty="No orientation data yet (Direct / Indirect)." onPick={(row) => setDrillDown({ cardTitle: "Orientation", row })} />
        <StatCard title="Driver location" rows={stats.driverLocation} empty="Internal vs External driver — no data yet." onPick={(row) => setDrillDown({ cardTitle: "Driver location", row })} />
        <StatCard title="Dimming" rows={stats.dimming} empty="No dimming protocol data yet." onPick={(row) => setDrillDown({ cardTitle: "Dimming", row })} />
        <StatCard title="Customization" rows={stats.customization} empty="No customization data yet." onPick={(row) => setDrillDown({ cardTitle: "Customization", row })} />
        <StatCard title="Accessories" rows={stats.accessories} empty="No accessory data yet." onPick={(row) => setDrillDown({ cardTitle: "Accessories", row })} />
        <StatCard title="Categories" rows={stats.categories} empty="No categories yet." onPick={(row) => setDrillDown({ cardTitle: "Categories", row })} />
        <StatCard title="Max length" rows={stats.maxLengths} empty="No max-length data yet." onPick={(row) => setDrillDown({ cardTitle: "Max length", row })} />
        <StatCard title="IP Rating" rows={stats.ip} empty="No IP data yet." onPick={(row) => setDrillDown({ cardTitle: "IP Rating", row })} />
        <StatCard title="CCT" rows={stats.cct} empty="No CCT data yet." onPick={(row) => setDrillDown({ cardTitle: "CCT", row })} />
        <StatCard title="Wattage" rows={stats.wattage} empty="No wattage data yet." onPick={(row) => setDrillDown({ cardTitle: "Wattage", row })} />
        <StatCard title="Lumens" rows={stats.lumens} empty="No lumen data yet." onPick={(row) => setDrillDown({ cardTitle: "Lumens", row })} />
        <StatCard title="Efficacy (lm/W)" rows={stats.efficacy} empty="No efficacy data yet." onPick={(row) => setDrillDown({ cardTitle: "Efficacy", row })} />
        <StatCard title="CRI" rows={stats.cri} empty="No CRI data yet." onPick={(row) => setDrillDown({ cardTitle: "CRI", row })} />
        <StatCard title="Beam angle" rows={stats.beam} empty="No beam-angle data yet." onPick={(row) => setDrillDown({ cardTitle: "Beam angle", row })} />
        <StatCard title="Voltage" rows={stats.voltage} empty="No voltage data yet." onPick={(row) => setDrillDown({ cardTitle: "Voltage", row })} />
        <StatCard title="Finishes" rows={stats.finishes} empty="No finish data yet." onPick={(row) => setDrillDown({ cardTitle: "Finishes", row })} />
        <StatCard title="Colors" rows={stats.colors} empty="No color data yet." onPick={(row) => setDrillDown({ cardTitle: "Colors", row })} />
        <StatCard title="Certifications" rows={stats.certs} empty="No cert data yet." onPick={(row) => setDrillDown({ cardTitle: "Certifications", row })} />
      </div>

      {drillDown && (
        <div
          className="summary-drilldown-bg"
          onClick={() => setDrillDown(null)}
        >
          <div
            className="summary-drilldown"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="summary-drilldown-head">
              <div>
                <div className="d-eyebrow">{drillDown.cardTitle}</div>
                <h3>{drillDown.row.value}</h3>
                <p style={{ margin: "2px 0 0", fontSize: 12.5, color: "var(--muted)" }}>
                  {drillDown.row.productRefs.length} product
                  {drillDown.row.productRefs.length === 1 ? "" : "s"} match{drillDown.row.productRefs.length === 1 ? "es" : ""} this value · {drillDown.row.count} total mention{drillDown.row.count === 1 ? "" : "s"}
                </p>
              </div>
              <button
                className="btn sm"
                onClick={() => setDrillDown(null)}
              >
                Close
              </button>
            </div>
            <div className="summary-drilldown-body">
              {drillDown.row.productRefs.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="summary-drilldown-item"
                  onClick={() => {
                    setSelectedProductId(p.id);
                    setDrillDown(null);
                  }}
                >
                  <div className="summary-drilldown-brand">{p.brandName || "—"}</div>
                  <div className="summary-drilldown-name">{p.name}</div>
                  <span className="summary-drilldown-arrow">→</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {topBrands.length > 0 && (
        <div className="d-card">
          <h4>Top brands by catalog size</h4>
          <div className="stat-rows">
            {topBrands.map((b) => (
              <div key={b.name} className="stat-row">
                <div className="stat-row-bar">
                  <div
                    className="stat-row-fill"
                    style={{
                      width: `${Math.max(
                        4,
                        (b.count / Math.max(1, topBrands[0].count)) * 100,
                      )}%`,
                    }}
                  />
                  <span className="stat-row-label">{b.name}</span>
                </div>
                <span className="stat-row-count">{b.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {aiSummary && (
        <div className="d-card bm-ai">
          <h4>✨ AI summary</h4>
          <div className="bm-ai-grid">
            <div>
              <h5>Market standard</h5>
              <ul className="bm-list">
                {aiSummary.marketStandard.commonMountings.length > 0 && (
                  <li><strong>Mounting:</strong> {aiSummary.marketStandard.commonMountings.join(", ")}</li>
                )}
                {aiSummary.marketStandard.commonFinishes.length > 0 && (
                  <li><strong>Finishes:</strong> {aiSummary.marketStandard.commonFinishes.join(", ")}</li>
                )}
                {aiSummary.marketStandard.commonDimensions.length > 0 && (
                  <li><strong>Dimensions:</strong> {aiSummary.marketStandard.commonDimensions.join(", ")}</li>
                )}
                {aiSummary.marketStandard.commonWattages.length > 0 && (
                  <li><strong>Wattages:</strong> {aiSummary.marketStandard.commonWattages.join(", ")}</li>
                )}
                {aiSummary.marketStandard.commonLumenRanges.length > 0 && (
                  <li><strong>Lumens:</strong> {aiSummary.marketStandard.commonLumenRanges.join(", ")}</li>
                )}
                {aiSummary.marketStandard.commonCcts.length > 0 && (
                  <li><strong>CCTs:</strong> {aiSummary.marketStandard.commonCcts.join(", ")}</li>
                )}
                {aiSummary.marketStandard.commonIpRatings.length > 0 && (
                  <li><strong>IP:</strong> {aiSummary.marketStandard.commonIpRatings.join(", ")}</li>
                )}
              </ul>
            </div>
            <div>
              <h5>Categories</h5>
              <ul className="bm-list">
                {aiSummary.categoryBreakdown.map((c, i) => (
                  <li key={i}>
                    <strong>{c.category}</strong> ({c.count}) — {c.examples.slice(0, 4).join(", ")}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h5>Gaps / opportunities</h5>
              <ul className="bm-list">
                {aiSummary.gaps.map((g, i) => <li key={i}>{g}</li>)}
              </ul>
            </div>
            <div>
              <h5>Differentiators</h5>
              <ul className="bm-list">
                {aiSummary.differentiators.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            </div>
          </div>
        </div>
      )}

      {selected && (
        <ProductDetailDrawer
          product={selected.product}
          brandName={selected.brandName}
          canEdit={canEdit}
          onToast={onToast}
          onClose={() => setSelectedProductId(null)}
        />
      )}
    </div>
  );
}

function StatCard({
  title,
  rows,
  empty,
  onPick,
}: {
  title: string;
  rows: StatRow[];
  empty: string;
  onPick?: (row: StatRow) => void;
}) {
  if (!rows.length) {
    return (
      <div className="d-card stat-card">
        <h4>{title}</h4>
        <div style={{ fontSize: 12, color: "var(--muted)", padding: "6px 0" }}>{empty}</div>
      </div>
    );
  }
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <div className="d-card stat-card">
      <h4>
        {title}
        <span className="stat-card-badge">{rows.length}</span>
      </h4>
      <div className="stat-rows-scroll">
        <div className="stat-rows">
          {rows.map((r) => (
            <button
              key={r.value}
              type="button"
              className="stat-row stat-row-clickable"
              onClick={() => onPick?.(r)}
              title={`Click to see the ${r.count} product${r.count === 1 ? "" : "s"} with this value`}
            >
              <div className="stat-row-bar">
                <div
                  className="stat-row-fill"
                  style={{ width: `${Math.max(4, (r.count / total) * 100)}%` }}
                />
                <span className="stat-row-label">{r.value}</span>
              </div>
              <span className="stat-row-count">{r.count}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

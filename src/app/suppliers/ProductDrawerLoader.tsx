"use client";

// Lazy loader for the existing per-supplier ProductDrawer. Fetches the
// supplier's products on demand, finds the requested part + its
// configurations, and hands the data to the same ProductDrawer that
// powers the per-supplier catalog. Lets the Supplier Inventory
// overview open a part inline without switching to the Suppliers sub-
// tab.

import { useEffect, useMemo, useState } from "react";
import { ProductDrawer } from "./SupplierInventoryTab";
import {
  listSupplierProducts,
  type SupplierProductWithAttachments,
} from "./supplier-inventory-actions";

export default function ProductDrawerLoader({
  partId,
  supplierId,
  canEdit,
  onClose,
  onChanged,
}: {
  partId: number;
  supplierId: number;
  canEdit: boolean;
  onClose: () => void;
  // Called after the drawer reports a change so the parent can refresh
  // its aggregate list (counts, project tags, etc.).
  onChanged?: () => void;
}) {
  const [products, setProducts] = useState<SupplierProductWithAttachments[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The drawer treats this id as the active product — clicking a
  // configuration row swaps to that model without us having to swap
  // drawers.
  const [openId, setOpenId] = useState<number>(partId);

  function reload() {
    listSupplierProducts({ supplierId })
      .then(setProducts)
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierId]);

  // Keep openId in sync when the parent swaps to a different part id
  // (e.g. the overview re-opens after a click).
  useEffect(() => {
    setOpenId(partId);
  }, [partId]);

  const product = useMemo(
    () => (products ?? []).find((p) => p.id === openId) ?? null,
    [products, openId],
  );

  const modelsByParent = useMemo(() => {
    const map = new Map<number, SupplierProductWithAttachments[]>();
    for (const p of products ?? []) {
      if (p.parentProductId != null) {
        const list = map.get(p.parentProductId) ?? [];
        list.push(p);
        map.set(p.parentProductId, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return map;
  }, [products]);

  if (err) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.6)",
          zIndex: 250,
          display: "grid",
          placeItems: "center",
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            padding: 20,
            borderRadius: 10,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            color: "#dc2626",
            fontSize: 13,
            maxWidth: 360,
          }}
        >
          {err}
          <div style={{ marginTop: 12, textAlign: "right" }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "6px 14px",
                borderRadius: 999,
                background: "var(--lb-bg)",
                border: "1px solid var(--lb-border)",
                color: "var(--lb-text)",
                cursor: "pointer",
                fontSize: 12.5,
              }}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (products === null) {
    // Lightweight loading overlay so the open feels immediate.
    return (
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.45)",
          zIndex: 250,
          display: "grid",
          placeItems: "center",
          color: "white",
          fontSize: 13,
        }}
      >
        Loading part…
      </div>
    );
  }

  if (!product) {
    // The product was deleted between when the overview rendered and
    // when the user clicked the card. Fail soft.
    return (
      <div
        role="dialog"
        aria-modal="true"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          zIndex: 250,
          display: "grid",
          placeItems: "center",
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            padding: 20,
            borderRadius: 10,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            color: "var(--lb-text)",
            fontSize: 13,
            maxWidth: 360,
            textAlign: "center",
          }}
        >
          This part is no longer available.
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "6px 14px",
                borderRadius: 999,
                background: "var(--lb-bg)",
                border: "1px solid var(--lb-border)",
                color: "var(--lb-text)",
                cursor: "pointer",
                fontSize: 12.5,
              }}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const parentProduct =
    product.parentProductId != null
      ? products.find((p) => p.id === product.parentProductId) ?? null
      : null;

  return (
    <ProductDrawer
      product={product}
      models={modelsByParent.get(product.id) ?? []}
      parentProduct={parentProduct}
      allProducts={products}
      canEdit={canEdit}
      onClose={onClose}
      onChanged={() => {
        reload();
        onChanged?.();
      }}
      onOpenSibling={(id) => setOpenId(id)}
    />
  );
}

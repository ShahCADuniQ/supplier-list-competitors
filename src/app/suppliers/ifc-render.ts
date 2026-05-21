"use client";

// Client-side IFC renderer — loads an .ifc blob with web-ifc, builds the
// meshes into a Three.js scene, frames an isometric camera, captures the
// canvas as a PNG, then disposes everything.
//
// Two entry points:
//   • renderIfcIsometric  → one PNG of the whole model (legacy callers).
//   • renderIfcMultipart  → one PNG for the whole model PLUS one per part
//     group (filtered by expressIDs). Used by the Orders AutoFill flow so
//     every part AND the assembly gets its own card thumbnail without
//     re-parsing the 159 MB IFC 13 times.
//
// Heavy: web-ifc WASM is ~10 MB, downloaded once on first call and cached
// by the browser.

import * as THREE from "three";

// Index built by buildIfcMeshIndex — caches a per-expressID list of
// Three.js meshes so we can render the whole IFC once + N filtered
// per-part views without reloading the model each time.
type IfcMeshIndex = {
  meshesByExpressId: Map<number, THREE.Mesh[]>;
  // Whole-model bounding box. Per-part renders re-frame on their own bbox,
  // but the assembly render uses this so the camera distance matches what
  // the original single-PNG renderer produced.
  fullBBox: THREE.Box3;
};

// Whole-IFC render — backwards-compatible single-PNG entry point.
export async function renderIfcIsometric(input: {
  bytes: Uint8Array;
  size?: number;
}): Promise<Blob> {
  const out = await renderIfcMultipart({
    bytes: input.bytes,
    size: input.size,
    groups: [{ key: "assembly" }],
  });
  const blob = out.get("assembly");
  if (!blob) throw new Error("Failed to render IFC");
  return blob;
}

// Render the IFC into multiple isometric PNGs in one shot. The web-ifc
// model is parsed ONCE and every PlacedGeometry is built into a Three.js
// mesh exactly once; per-group renders just rebuild a small Group from
// the filtered subset of those cached meshes.
export async function renderIfcMultipart(input: {
  bytes: Uint8Array;
  size?: number;
  groups: Array<{
    key: string;
    // Empty / undefined → render the whole model (use for the assembly card).
    // Non-empty → include only meshes whose expressID is in this list.
    expressIds?: number[];
  }>;
  // Optional progress callback — fires after each PNG is produced so the
  // caller can update a progress bar. (key, doneCount, totalCount).
  onProgress?: (key: string, done: number, total: number) => void;
}): Promise<Map<string, Blob>> {
  const size = input.size ?? 512;
  const index = await buildIfcMeshIndex(input.bytes);
  const out = new Map<string, Blob>();
  try {
    let done = 0;
    for (const g of input.groups) {
      const includeSet = g.expressIds && g.expressIds.length > 0
        ? new Set(g.expressIds)
        : null;
      try {
        const blob = await renderFromIndex({ index, size, includeExpressIds: includeSet });
        out.set(g.key, blob);
      } catch (e) {
        // Per-part render failure shouldn't abort the whole batch — log
        // and continue so the assembly + the parts that DO render still
        // show up on their cards.
        console.warn(`[ifc-render] group "${g.key}" failed:`, e);
      }
      done += 1;
      input.onProgress?.(g.key, done, input.groups.length);
    }
  } finally {
    // Free every Three.js geometry / material the index holds onto.
    for (const meshes of index.meshesByExpressId.values()) {
      for (const m of meshes) {
        m.geometry.dispose();
        if (Array.isArray(m.material)) m.material.forEach((mat) => mat.dispose());
        else m.material.dispose();
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals — load web-ifc once, build a per-expressID mesh index, then
// render filtered subsets of it as many times as the caller wants.
// ─────────────────────────────────────────────────────────────────────────────

async function buildIfcMeshIndex(bytes: Uint8Array): Promise<IfcMeshIndex> {
  const ifcModule = await import("web-ifc");
  const api = new ifcModule.IfcAPI();
  // web-ifc needs to know where to fetch the .wasm. The dist file is
  // bundled by Next.js automatically when imported via web-ifc — but to
  // be safe on edge cases we point at the CDN copy. Browsers cache it.
  api.SetWasmPath("https://unpkg.com/web-ifc@0.0.69/", true);
  await api.Init();

  const modelID = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true });
  const meshesByExpressId = new Map<number, THREE.Mesh[]>();
  const fullBBox = new THREE.Box3();
  try {
    const meshVec = api.LoadAllGeometry(modelID);
    for (let i = 0; i < meshVec.size(); i++) {
      const flatMesh = meshVec.get(i);
      const expressID = flatMesh.expressID as number;
      const meshes: THREE.Mesh[] = [];
      const placedGeoms = flatMesh.geometries;
      for (let j = 0; j < placedGeoms.size(); j++) {
        const placed = placedGeoms.get(j);
        const geom = api.GetGeometry(modelID, placed.geometryExpressID);
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        const bufferGeom = new THREE.BufferGeometry();
        // Vertex layout from web-ifc: [x, y, z, nx, ny, nz] × N
        const positions = new Float32Array(verts.length / 2);
        const normals = new Float32Array(verts.length / 2);
        for (let k = 0, p = 0; k < verts.length; k += 6, p += 3) {
          positions[p] = verts[k];
          positions[p + 1] = verts[k + 1];
          positions[p + 2] = verts[k + 2];
          normals[p] = verts[k + 3];
          normals[p + 1] = verts[k + 4];
          normals[p + 2] = verts[k + 5];
        }
        bufferGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        bufferGeom.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
        bufferGeom.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
        const mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(placed.color.x, placed.color.y, placed.color.z),
          transparent: placed.color.w !== 1,
          opacity: placed.color.w,
          metalness: 0.1,
          roughness: 0.6,
        });
        const mesh = new THREE.Mesh(bufferGeom, mat);
        // web-ifc returns the placement as a 16-float column-major matrix.
        const m = new THREE.Matrix4().fromArray(placed.flatTransformation);
        mesh.applyMatrix4(m);
        meshes.push(mesh);
        // Accumulate the whole-model bbox as we go.
        mesh.geometry.computeBoundingBox();
        const bb = mesh.geometry.boundingBox;
        if (bb) {
          const world = bb.clone().applyMatrix4(mesh.matrix);
          fullBBox.union(world);
        }

        geom.delete();
      }
      // One IfcProduct may produce multiple PlacedGeometry entries (e.g.
      // an assembly that's an instanced mapped item across colour layers).
      // Group them under the SAME expressID so the per-part filter picks
      // up the full set.
      if (meshes.length > 0) {
        const existing = meshesByExpressId.get(expressID);
        if (existing) existing.push(...meshes);
        else meshesByExpressId.set(expressID, meshes);
      }
    }
  } finally {
    api.CloseModel(modelID);
  }
  return { meshesByExpressId, fullBBox };
}

async function renderFromIndex(opts: {
  index: IfcMeshIndex;
  size: number;
  // null → include EVERY mesh (assembly render).
  // non-null → only meshes whose expressID is in this set (per-part).
  includeExpressIds: Set<number> | null;
}): Promise<Blob> {
  const { index, size, includeExpressIds } = opts;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf5f5f7);
  const group = new THREE.Group();
  scene.add(group);

  // Clone the cached meshes into THIS scene so we can dispose the scene
  // without nuking the cache. Three.js Mesh.clone() shares geometry +
  // material — which is fine, since we dispose the cache once at the end
  // of renderIfcMultipart, not per-render.
  let included = 0;
  for (const [expressID, meshes] of index.meshesByExpressId) {
    if (includeExpressIds && !includeExpressIds.has(expressID)) continue;
    for (const m of meshes) {
      const clone = new THREE.Mesh(m.geometry, m.material);
      clone.matrix.copy(m.matrix);
      clone.matrixAutoUpdate = false;
      group.add(clone);
      included += 1;
    }
  }
  if (included === 0) throw new Error("No matching geometry for this group");

  // Lighting — soft hemisphere + a single key light for shape definition.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 0.8));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(5, 10, 7);
  scene.add(key);

  // Frame on the bounding box of THIS group. Per-part renders should fill
  // their own canvas (not look like a tiny dot inside the whole-assembly
  // frame), so we re-compute bbox locally.
  const bbox = new THREE.Box3().setFromObject(group);
  if (!isFinite(bbox.min.x)) throw new Error("Group has no renderable geometry");
  const center = bbox.getCenter(new THREE.Vector3());
  const sizeV = bbox.getSize(new THREE.Vector3());
  const maxDim = Math.max(sizeV.x, sizeV.y, sizeV.z);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(size, size, false);
  renderer.setPixelRatio(1);

  const aspect = 1;
  const orthoHalf = maxDim * 0.65;
  const camera = new THREE.OrthographicCamera(
    -orthoHalf * aspect,
    orthoHalf * aspect,
    orthoHalf,
    -orthoHalf,
    0.01,
    maxDim * 20,
  );
  // Classic isometric: 30°-down, -45° around vertical.
  const dist = maxDim * 3;
  const dir = new THREE.Vector3(1, 1, 1).normalize();
  camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
  camera.up.set(0, 1, 0);
  camera.lookAt(center);

  renderer.render(scene, camera);

  const blob = await new Promise<Blob | null>((resolve) => {
    renderer.domElement.toBlob((b) => resolve(b), "image/png");
  });

  renderer.dispose();
  // NB: do NOT dispose the clones' geometry/material — they're shared
  // with the cache, which the caller disposes at the very end.

  if (!blob) throw new Error("Failed to capture render");
  return blob;
}

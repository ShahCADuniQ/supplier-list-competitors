/**
 * One-shot seeder for Lightbase.
 *
 * Suppliers come from `scripts/suppliers-169.json` (exported from the original
 * Lightbase Supplier Manager HTML). NO project entries are inserted — the user
 * explicitly wants the dashboard to start with no scores/grades since there's
 * no PO performance data yet. Comments and supplier intel ARE imported.
 *
 * Run with `npm run db:seed`. Idempotent: skips when data already exists. Pass
 * `--force` to wipe and reload.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../src/db";
import {
  suppliers,
  supplierComments,
  competitorCollections,
  competitors,
} from "../src/db/schema";

type SupplierStatus = "Active" | "Historical";
type TierKey = "mass" | "mid" | "spec" | "premium";

type RawSupplier = {
  id: number;
  name: string;
  category?: string;
  subCategory?: string;
  specialties?: string;
  products?: string;
  projects?: string[];
  origin?: string;
  contactName?: string;
  email?: string;
  website?: string;
  phone?: string;
  tested?: string;
  status?: string;
  source?: string;
  comments?: { text: string; project?: string; date?: string; author?: string }[];
};

type SeedBrand = {
  name: string;
  website?: string;
  parent?: string;
  tierKey: TierKey;
  tier?: string;
  segment?: string;
  country?: string;
  productLines?: string;
  channel?: string;
  notes?: string;
  capabilities?: string[];
};

const here = dirname(fileURLToPath(import.meta.url));
const RAW_SUPPLIERS: RawSupplier[] = JSON.parse(
  readFileSync(resolve(here, "suppliers-169.json"), "utf8"),
);

function asStatus(s: string | undefined): SupplierStatus {
  return s === "Historical" ? "Historical" : "Active";
}

function joinNotes(specialties?: string, source?: string): string | undefined {
  // Specialties is the closest equivalent to the v2 schema's `notes`. Source
  // already maps to its own column, so leave it out of notes.
  const trimmed = (specialties ?? "").trim();
  return trimmed ? trimmed : undefined;
}

function dateOnly(iso?: string): string {
  if (!iso) return new Date().toISOString().slice(0, 10);
  // accept "2026-04-09T00:00:00" or "2026-04-09"
  return iso.slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPETITORS — unchanged from the Linear Lights tracker
// ─────────────────────────────────────────────────────────────────────────────

const COMPETITOR_DATA: SeedBrand[] = [
  { name: "Lithonia Lighting", website: "https://lithonia.acuitybrands.com", parent: "Acuity Brands", tierKey: "spec", tier: "Spec / mass-spec", segment: "Architectural, commercial", country: "USA (Conyers, GA)", productLines: "BLT, RTLED, CSS, ZL1N, IBL, RT5, CPRB linear", channel: "Distributor / agency", notes: "Largest U.S. lighting maker; broadest linear catalog in the industry.", capabilities: ["Utility Strip/Shop", "Wraparound", "Vapor-Tight (IP65+)", "Linear High-Bay", "Recessed Troffer", "Architectural Recessed Slot", "Suspended Pendant – Direct", "Tunable White / Smart"] },
  { name: "Mark Architectural Lighting", website: "https://www.markarchitectural.com", parent: "Acuity Brands", tierKey: "spec", tier: "Spec", segment: "Architectural", country: "USA", productLines: "Slot 4, Slot 6, Slot 2, RBSL recessed linear", channel: "Agency / spec", notes: "Founded 1965; acquired by Acuity in 2007. Slot linear specialist.", capabilities: ["Architectural Recessed Slot", "Custom / Bespoke", "Tunable White / Smart"] },
  { name: "Holophane", website: "https://www.holophane.com", parent: "Acuity Brands", tierKey: "spec", tier: "Industrial spec", segment: "Industrial, outdoor", country: "USA", productLines: "Industrial linear & high-bay", channel: "Distributor", notes: "Heritage industrial brand under Acuity. Strong outdoor and high-bay.", capabilities: ["Linear High-Bay", "Vapor-Tight (IP65+)"] },
  { name: "Cooper Lighting Solutions", website: "https://www.cooperlighting.com", parent: "Signify (Philips)", tierKey: "spec", tier: "Spec / mass-spec", segment: "Architectural, commercial, industrial", country: "USA (Peachtree City, GA)", productLines: "Metalux, Corelite, Neo-Ray, Fail-Safe, Halo", channel: "Distributor / agency", notes: "Owned by Signify since 2020. Second-largest U.S. linear catalog.", capabilities: ["Utility Strip/Shop", "Wraparound", "Vapor-Tight (IP65+)", "Linear High-Bay", "Recessed Troffer", "Architectural Recessed Slot", "Suspended Pendant – Direct", "Suspended Pendant – Direct/Indirect", "Under-Cabinet", "Tunable White / Smart"] },
  { name: "Metalux", website: "https://www.cooperlighting.com/global/brands/metalux", parent: "Cooper Lighting", tierKey: "mass", tier: "Mass / utility", segment: "Commercial, industrial, garage", country: "USA", productLines: "SL strip, SNLED, 4SL/8SL series", channel: "Home Depot, distributors", notes: "Top-volume commercial strip brand at Home Depot.", capabilities: ["Utility Strip/Shop", "Wraparound", "Vapor-Tight (IP65+)"] },
  { name: "Corelite", website: "https://www.cooperlighting.com/global/brands/corelite", parent: "Cooper Lighting", tierKey: "spec", tier: "Architectural spec", segment: "Architectural", country: "USA", productLines: "Class R/RE, Surround, Effects linear", channel: "Spec / agency", notes: "Premium architectural sub-brand of Cooper.", capabilities: ["Architectural Recessed Slot", "Suspended Pendant – Direct", "Suspended Pendant – Direct/Indirect", "Tunable White / Smart"] },
  { name: "Neo-Ray", website: "https://www.cooperlighting.com/global/brands/neo-ray", parent: "Cooper Lighting", tierKey: "spec", tier: "Architectural spec", segment: "Architectural", country: "USA", productLines: "Define, Cyrus, Pinnacle linear pendants", channel: "Spec / agency", notes: "Pendant linear specialist within Cooper.", capabilities: ["Suspended Pendant – Direct", "Suspended Pendant – Direct/Indirect", "Custom / Bespoke"] },
  { name: "Cree Lighting", website: "https://www.creelighting.com", parent: "IDEAL Industries", tierKey: "spec", tier: "Spec / commercial", segment: "Commercial, industrial", country: "USA (Racine, WI)", productLines: "Styllus Linear, ZR Series, KBL, LR linear", channel: "Distributor", notes: "Strong efficacy and warranty. Reliable spec-tier choice.", capabilities: ["Architectural Recessed Slot", "Suspended Pendant – Direct", "Linear High-Bay", "Recessed Troffer", "Tunable White / Smart"] },
  { name: "WAC Lighting", website: "https://www.waclighting.com", parent: "Private", tierKey: "premium", tier: "Spec / premium", segment: "Architectural, residential, retail", country: "USA (NY)", productLines: "InvisiLED, LINE 2.0, Aether linear, Loft series", channel: "Showroom / spec / online", notes: "Premium architectural and decorative. Strong tape/strip portfolio.", capabilities: ["LED Tape / Cove", "Aluminum Extrusion + Tape", "Wall-Wash / Asymmetric", "Under-Cabinet", "Tunable White / Smart", "RGB / Color"] },
  { name: "Precision Architectural Lighting", website: "https://www.pal-lighting.com", parent: "Private", tierKey: "spec", tier: "Architectural spec", segment: "Architectural", country: "USA (Houston, TX)", productLines: "Custom linear pendants and recessed", channel: "Agency / spec", notes: "Founded 1988; linear-focused.", capabilities: ["Suspended Pendant – Direct", "Suspended Pendant – Direct/Indirect", "Architectural Recessed Slot", "Custom / Bespoke"] },
  { name: "Focal Point", website: "https://www.focalpointlights.com", parent: "Private", tierKey: "spec", tier: "Architectural spec", segment: "Architectural", country: "USA (Chicago, IL)", productLines: "Seem 1/2/4, ID+, Lite, Echo linear", channel: "Agency / spec", notes: "Linear and architectural specialist with strong continuous-run.", capabilities: ["Architectural Recessed Slot", "Suspended Pendant – Direct", "Suspended Pendant – Direct/Indirect", "Custom / Bespoke", "Tunable White / Smart"] },
  { name: "Pinnacle Architectural Lighting", website: "https://www.pinnacle-ltg.com", parent: "Private", tierKey: "spec", tier: "Architectural spec", segment: "Architectural", country: "USA (Denver, CO)", productLines: "Edge, Edge One, Tesla, Pinch linear pendants", channel: "Agency / spec", notes: "Linear pendant specialist. Edge-lit aesthetic leader.", capabilities: ["Suspended Pendant – Direct", "Suspended Pendant – Direct/Indirect", "Architectural Recessed Slot", "Custom / Bespoke"] },
  { name: "Finelite", website: "https://www.finelite.com", parent: "Private", tierKey: "spec", tier: "Architectural spec", segment: "Architectural, education", country: "USA (Union City, CA)", productLines: "HP-2, HP-4, Series 4, Personal linear", channel: "Agency / spec", notes: "Built-to-order with notably fast lead times.", capabilities: ["Suspended Pendant – Direct", "Suspended Pendant – Direct/Indirect", "Architectural Recessed Slot", "Custom / Bespoke", "Tunable White / Smart"] },
  { name: "Axis Lighting", website: "https://www.axislighting.com", parent: "Private", tierKey: "spec", tier: "Architectural spec", segment: "Architectural", country: "Canada (Montréal)", productLines: "BeamLED, Skybeam, Maglev linear", channel: "Agency / spec", notes: "Premium continuous-run linear. Strong design-led aesthetic.", capabilities: ["Suspended Pendant – Direct", "Suspended Pendant – Direct/Indirect", "Architectural Recessed Slot", "Stair / Step Integrated", "Custom / Bespoke", "Tunable White / Smart"] },
  { name: "Selux", website: "https://www.selux.com", parent: "Private", tierKey: "spec", tier: "Architectural spec", segment: "Architectural, outdoor", country: "Germany / USA", productLines: "M36, M60 linear, Tubilux", channel: "Agency / spec", notes: "European architectural with outdoor strength.", capabilities: ["Architectural Recessed Slot", "Wall-Wash / Asymmetric", "Suspended Pendant – Direct", "Stair / Step Integrated", "Custom / Bespoke"] },
  { name: "XAL", website: "https://www.xal.com", parent: "Private", tierKey: "spec", tier: "Architectural spec", segment: "Architectural", country: "Austria", productLines: "MINO, MENO, COMBO, FRAME linear", channel: "Agency / spec", notes: "Premium recessed and pendant linear with deep DALI control.", capabilities: ["Architectural Recessed Slot", "Suspended Pendant – Direct", "Suspended Pendant – Direct/Indirect", "Wall-Wash / Asymmetric", "Tunable White / Smart", "Custom / Bespoke"] },
  { name: "Zumtobel", website: "https://www.zumtobel.com", parent: "Zumtobel Group", tierKey: "spec", tier: "Architectural spec", segment: "Architectural", country: "Austria", productLines: "SLOTLIGHT, LINETIK, LINARIA", channel: "Agency / spec", notes: "European leader; integrated control + fixture systems.", capabilities: ["Architectural Recessed Slot", "Suspended Pendant – Direct", "Tunable White / Smart", "Custom / Bespoke"] },
  { name: "ERCO", website: "https://www.erco.com", parent: "Private", tierKey: "spec", tier: "Architectural spec", segment: "Architectural, museum", country: "Germany", productLines: "Compar, Jilly linear", channel: "Agency / spec", notes: "Museum and retail focused. Asymmetric optics specialist.", capabilities: ["Wall-Wash / Asymmetric", "Architectural Recessed Slot", "Custom / Bespoke"] },
  { name: "Linea Light", website: "https://www.linealight.com", parent: "Linea Light Group", tierKey: "spec", tier: "Architectural spec", segment: "Architectural, outdoor", country: "Italy", productLines: "iN profiles, Conus", channel: "Agency / spec", notes: "European architectural; strong indoor/outdoor crossover.", capabilities: ["Architectural Recessed Slot", "Aluminum Extrusion + Tape", "Stair / Step Integrated", "Custom / Bespoke"] },
  { name: "iGuzzini", website: "https://www.iguzzini.com", parent: "Fagerhult Group", tierKey: "spec", tier: "Architectural spec", segment: "Architectural", country: "Italy", productLines: "Underscore, Laser, Trick linear", channel: "Agency / spec", notes: "Premium European spec brand.", capabilities: ["LED Tape / Cove", "Architectural Recessed Slot", "Wall-Wash / Asymmetric", "Custom / Bespoke"] },
  { name: "Fagerhult", website: "https://www.fagerhult.com", parent: "Fagerhult Group", tierKey: "spec", tier: "Architectural spec", segment: "Architectural, education", country: "Sweden", productLines: "Pleiad, Notor, Indoviva", channel: "Agency / spec", notes: "Nordic architectural; strong in education.", capabilities: ["Suspended Pendant – Direct", "Suspended Pendant – Direct/Indirect", "Recessed Troffer", "Tunable White / Smart"] },
  { name: "Glamox", website: "https://glamox.com", parent: "Glamox Group", tierKey: "mid", tier: "Industrial / marine", segment: "Industrial, marine, education", country: "Norway", productLines: "C90-S, MIR linear", channel: "Agency / distributor", notes: "Marine and industrial linear specialist.", capabilities: ["Vapor-Tight (IP65+)", "Linear High-Bay", "Recessed Troffer"] },
  { name: "Trilux", website: "https://www.trilux.com", parent: "Private", tierKey: "spec", tier: "Architectural spec", segment: "Architectural, industrial", country: "Germany", productLines: "E-Line, Solvan, Scuba linear", channel: "Agency / spec", notes: "European trunking specialist. Strong continuous-run industrial.", capabilities: ["LED Batten", "Linear High-Bay", "Vapor-Tight (IP65+)", "Architectural Recessed Slot"] },
  { name: "Ledvance / Sylvania", website: "https://www.ledvance.com", parent: "MLS Group", tierKey: "mid", tier: "Mass / mid", segment: "Commercial, residential", country: "Germany / USA", productLines: "ValueBay, LINEAR LED batten", channel: "Distributor / retail", notes: "Former Osram general lighting business.", capabilities: ["LED Batten", "T5/T8 Retrofit", "Utility Strip/Shop"] },
  { name: "Signify (Philips)", website: "https://www.signify.com", parent: "Signify", tierKey: "mid", tier: "Mass / spec", segment: "Commercial, residential", country: "Netherlands", productLines: "Maxos LED, CoreLine, LuxSpace linear", channel: "Distributor / retail", notes: "Global largest pure-play lighting company.", capabilities: ["LED Batten", "Utility Strip/Shop", "Recessed Troffer", "T5/T8 Retrofit", "Tunable White / Smart"] },
  { name: "RAB Lighting", website: "https://www.rabweb.com", parent: "Private", tierKey: "mid", tier: "Mid / commercial", segment: "Commercial, industrial", country: "USA (NJ)", productLines: "SHARK, STEALTH, BAYLED, RAILED linear", channel: "Distributor / online", notes: "Strong distributor channel; field-selectable wattage leader.", capabilities: ["Utility Strip/Shop", "Vapor-Tight (IP65+)", "Linear High-Bay", "Wraparound"] },
  { name: "Nora Lighting", website: "https://www.noralighting.com", parent: "Private", tierKey: "mid", tier: "Mid / spec", segment: "Architectural, residential", country: "USA (Commerce, CA)", productLines: "NULS, NUTP, Iolite linear / tape", channel: "Distributor / showroom", notes: "Tape and architectural linear; broad residential coverage.", capabilities: ["LED Tape / Cove", "Aluminum Extrusion + Tape", "Under-Cabinet", "Architectural Recessed Slot", "RGB / Color"] },
  { name: "MaxLite", website: "https://www.maxlite.com", parent: "Private", tierKey: "mid", tier: "Mid / commercial", segment: "Commercial, retrofit", country: "USA (NJ)", productLines: "LSU, c-Strip, MicroSlim linear", channel: "Distributor", notes: "Energy-efficient retrofits and selectable-W/CCT.", capabilities: ["Utility Strip/Shop", "Recessed Troffer", "T5/T8 Retrofit", "Wraparound"] },
  { name: "DALS Lighting", website: "https://www.dals.com", parent: "Private", tierKey: "mid", tier: "Mid / spec", segment: "Residential, hospitality", country: "Canada (Montréal)", productLines: "DCP, LinearAccent, SlimLED", channel: "Showroom / online", notes: "Modern residential linear; strong hospitality presence.", capabilities: ["Under-Cabinet", "LED Tape / Cove", "Aluminum Extrusion + Tape", "RGB / Color"] },
  { name: "Westgate Lighting", website: "https://westgatemfg.com", parent: "Private", tierKey: "mid", tier: "Mid / commercial", segment: "Commercial", country: "USA (CA)", productLines: "LLS, LRS-S linear strip", channel: "Distributor", notes: "Broad commercial value catalog.", capabilities: ["Utility Strip/Shop", "Vapor-Tight (IP65+)", "Linear High-Bay"] },
  { name: "Keystone Technologies", website: "https://www.keystonetech.com", parent: "Private", tierKey: "mid", tier: "Mid / commercial", segment: "Commercial, retrofit", country: "USA (PA)", productLines: "SmartDrive linear", channel: "Distributor", notes: "Common in retrofit projects.", capabilities: ["T5/T8 Retrofit", "Utility Strip/Shop"] },
  { name: "Satco / Nuvo", website: "https://www.satco.com", parent: "Satco Products", tierKey: "mid", tier: "Mid / commercial", segment: "Commercial, residential", country: "USA (NY)", productLines: "Nuvo washdown linear high-bay, LED battens", channel: "Distributor / retail", notes: "Broad lamp + fixture catalog. IP69K washdown specialist.", capabilities: ["Vapor-Tight (IP65+)", "Linear High-Bay", "LED Batten", "T5/T8 Retrofit"] },
  { name: "GE Current", website: "https://www.gecurrent.com", parent: "Current Lighting", tierKey: "mid", tier: "Mid / spec", segment: "Commercial, industrial", country: "USA (OH)", productLines: "Lumination, Albeo linear", channel: "Distributor / agency", notes: "Spun off from GE Lighting.", capabilities: ["Linear High-Bay", "Architectural Recessed Slot", "Suspended Pendant – Direct"] },
  { name: "Hubbell Lighting", website: "https://www.hubbell.com/hubbelllighting", parent: "Hubbell Inc.", tierKey: "spec", tier: "Spec / mid", segment: "Commercial, industrial", country: "USA (Greenville, SC)", productLines: "Columbia LCAT, Kim, Prescolite linear", channel: "Distributor / agency", notes: "Includes Columbia commercial. Strong spec channel.", capabilities: ["Recessed Troffer", "Vapor-Tight (IP65+)", "Linear High-Bay", "Architectural Recessed Slot"] },
  { name: "Columbia Lighting", website: "https://www.hubbell.com/columbialighting", parent: "Hubbell", tierKey: "mid", tier: "Mid / commercial", segment: "Commercial", country: "USA", productLines: "LCAT, LXEM, ZWS linear", channel: "Distributor", notes: "Strong recessed/troffer linear.", capabilities: ["Recessed Troffer", "Utility Strip/Shop", "Wraparound"] },
  { name: "Sunco Lighting", website: "https://sunco.com", parent: "Private", tierKey: "mass", tier: "Mass / value", segment: "Residential, light commercial", country: "USA (CA)", productLines: "4ft Linear Pendant, Linear Strip, Bar Lights", channel: "Online (Amazon, sunco.com)", notes: "DTC online value brand. Strong selectable-W/CCT pendants.", capabilities: ["Suspended Pendant – Direct/Indirect", "Utility Strip/Shop", "Under-Cabinet"] },
  { name: "Bulbrite", website: "https://www.bulbrite.com", parent: "Private", tierKey: "mid", tier: "Mid / decorative", segment: "Residential, retail", country: "USA", productLines: "Linear under-cabinet and tape", channel: "Showroom / online", notes: "Decorative and specialty.", capabilities: ["Under-Cabinet", "LED Tape / Cove"] },
  { name: "Hyperikon / HYPERLITE", website: "https://www.hyperikon.com", parent: "Private", tierKey: "mass", tier: "Mass / value", segment: "Garage, warehouse", country: "USA / China", productLines: "8ft and 4ft shop strip linear", channel: "Amazon", notes: "Top Amazon shop-light seller. Aggressive pricing.", capabilities: ["Utility Strip/Shop"] },
  { name: "ASD Lighting", website: "https://www.asdlighting.com", parent: "Private", tierKey: "mass", tier: "Mass / commercial", segment: "Commercial, garage", country: "USA (CA)", productLines: "8ft strip with EM backup, linear shop", channel: "Distributor / Amazon", notes: "DLC-listed value commercial; strong with EM backup variants.", capabilities: ["Utility Strip/Shop", "Vapor-Tight (IP65+)"] },
  { name: "Hykolity", website: "https://www.hykolity.com", parent: "Private", tierKey: "mass", tier: "Mass / value", segment: "Garage, warehouse", country: "USA / China", productLines: "4ft, 8ft shop strip linear", channel: "Amazon, Walmart", notes: "Amazon bestseller in 4ft shop.", capabilities: ["Utility Strip/Shop", "Linear High-Bay"] },
  { name: "Barrina", website: "https://www.barrinaled.com", parent: "Private", tierKey: "mass", tier: "Mass / value", segment: "Garage, residential", country: "USA / China", productLines: "T5 linear LED tube fixtures", channel: "Amazon", notes: "Linkable T5 strip leader on Amazon.", capabilities: ["T5/T8 Retrofit", "Utility Strip/Shop", "Under-Cabinet"] },
  { name: "RUN BISON", parent: "Private", tierKey: "mass", tier: "Mass / value", segment: "Commercial, garage", country: "USA / China", productLines: "4ft selectable strip with EM backup", channel: "Home Depot", notes: "Home Depot value strip with selectable W/CCT.", capabilities: ["Utility Strip/Shop"] },
  { name: "Elephant Depot", parent: "Private", tierKey: "mass", tier: "Mass / value", segment: "Garage, warehouse", country: "USA / China", productLines: "8ft selectable LED strip", channel: "Amazon", notes: "Amazon shop-light value brand.", capabilities: ["Utility Strip/Shop"] },
  { name: "Feit Electric", website: "https://www.feit.com", parent: "Private", tierKey: "mass", tier: "Mass / value", segment: "Residential, garage", country: "USA (CA)", productLines: "4ft and 8ft shop linear", channel: "Costco, Home Depot, Amazon", notes: "Costco-channel volume brand.", capabilities: ["Utility Strip/Shop", "Under-Cabinet"] },
  { name: "Commercial Electric", website: "https://www.homedepot.com/b/Commercial-Electric/N-5yc1vZmm9", parent: "Home Depot private label", tierKey: "mass", tier: "Mass / value", segment: "Commercial, residential", country: "USA", productLines: "4ft linear strip, wraparound", channel: "Home Depot", notes: "Home Depot exclusive private label.", capabilities: ["Utility Strip/Shop", "Wraparound"] },
  { name: "EcoSmart", website: "https://www.homedepot.com/b/EcoSmart/N-5yc1vZ16gh", parent: "Home Depot private label", tierKey: "mass", tier: "Mass / value", segment: "Residential, garage", country: "USA", productLines: "4ft shop / under-cabinet linear", channel: "Home Depot", notes: "Home Depot exclusive private label.", capabilities: ["Utility Strip/Shop", "Under-Cabinet"] },
  { name: "Utilitech", website: "https://www.lowes.com/pl/Utilitech", parent: "Lowe's private label", tierKey: "mass", tier: "Mass / value", segment: "Residential, garage", country: "USA", productLines: "4ft linear shop", channel: "Lowe's", notes: "Lowe's exclusive private label.", capabilities: ["Utility Strip/Shop", "Under-Cabinet"] },
  { name: "Honeywell Lighting", website: "https://www.honeywellstore.com/store/lighting.htm", parent: "Honeywell brand-licensed", tierKey: "mass", tier: "Mass / value", segment: "Garage, residential", country: "USA", productLines: "4ft / 8ft linkable shop linear", channel: "Costco, Sam's Club", notes: "Big-box volume; brand-licensed manufacturer.", capabilities: ["Utility Strip/Shop"] },
  { name: "Diode LED", website: "https://www.diodeled.com", parent: "Elite Lighting", tierKey: "premium", tier: "Spec / tape", segment: "Architectural, residential", country: "USA (Anaheim, CA)", productLines: "Valent, Fluid View, Blaze tape", channel: "Distributor / spec", notes: "Premium tape and channels with deep spec catalog.", capabilities: ["LED Tape / Cove", "Aluminum Extrusion + Tape", "RGB / Color", "Tunable White / Smart", "Stair / Step Integrated"] },
  { name: "Environmental Lights", website: "https://www.environmentallights.com", parent: "Private", tierKey: "premium", tier: "Spec / tape", segment: "Architectural, retail", country: "USA (San Diego, CA)", productLines: "Architectural tape, channels, drivers", channel: "Distributor / spec", notes: "Custom tape lighting house — strong AV/retail presence.", capabilities: ["LED Tape / Cove", "Aluminum Extrusion + Tape", "RGB / Color", "Custom / Bespoke"] },
  { name: "Hafele", website: "https://www.hafele.com", parent: "Hafele Group", tierKey: "mid", tier: "Mid / millwork", segment: "Residential, millwork", country: "Germany / USA", productLines: "Loox under-cabinet linear", channel: "Cabinet makers / specialty", notes: "Furniture millwork lighting; deep cabinet-maker integration.", capabilities: ["Under-Cabinet", "LED Tape / Cove"] },
  { name: "Tresco Lighting", website: "https://www.trescolighting.com", parent: "Private", tierKey: "mid", tier: "Mid / millwork", segment: "Residential, millwork", country: "USA", productLines: "L-LED, FreeLINK linear under-cabinet", channel: "Cabinet / showroom", notes: "Millwork specialty linear.", capabilities: ["Under-Cabinet", "LED Tape / Cove"] },
  { name: "Kichler", website: "https://www.kichler.com", parent: "Masco", tierKey: "mid", tier: "Mid / spec", segment: "Residential", country: "USA (Cleveland, OH)", productLines: "Under-cabinet linear, cove, tape", channel: "Showroom / online", notes: "Decorative/architectural residential.", capabilities: ["Under-Cabinet", "LED Tape / Cove", "Aluminum Extrusion + Tape"] },
  { name: "Tech Lighting", website: "https://www.techlighting.com", parent: "Generation Brands", tierKey: "premium", tier: "Spec / decorative", segment: "Architectural, residential", country: "USA", productLines: "Element by Tech, Unilume LED slimline", channel: "Showroom / spec", notes: "Decorative architectural linear; strong residential designer channel.", capabilities: ["Under-Cabinet", "LED Tape / Cove", "Architectural Recessed Slot"] },
];

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

const force = process.argv.includes("--force");

async function main() {
  console.log(
    `Seeding ${RAW_SUPPLIERS.length} suppliers (no project entries) and ${COMPETITOR_DATA.length} competitors…`,
  );

  if (force) {
    console.log("--force passed: clearing existing supplier and competitor data");
    await db.delete(suppliers); // cascades to project entries, comments, attachments
    await db.delete(competitorCollections); // cascades to competitors, attachments
  } else {
    const existingSuppliers = await db.select({ id: suppliers.id }).from(suppliers).limit(1);
    const existingCollections = await db.select({ id: competitorCollections.id }).from(competitorCollections).limit(1);
    if (existingSuppliers.length || existingCollections.length) {
      console.log(
        `Skipping: data already present (suppliers=${existingSuppliers.length}, collections=${existingCollections.length}). Re-run with --force to wipe and reload.`,
      );
      process.exit(0);
    }
  }

  // ── Suppliers ──
  let supplierCount = 0, commentCount = 0;
  for (const s of RAW_SUPPLIERS) {
    const [row] = await db
      .insert(suppliers)
      .values({
        name: s.name,
        category: s.category,
        subCategory: s.subCategory,
        origin: s.origin,
        status: asStatus(s.status),
        website: s.website || null,
        email: s.email || null,
        phone: s.phone || null,
        contactName: s.contactName || null,
        products: s.products || null,
        source: s.source || null,
        tested: s.tested || null,
        notes: joinNotes(s.specialties),
        kpis: {}, // deliberately empty — no risk/lead time/etc. ratings
      })
      .returning();
    supplierCount++;

    // Comments preserve the supplier intel from the original HTML.
    if (s.comments && s.comments.length) {
      await db.insert(supplierComments).values(
        s.comments.map((c) => ({
          supplierId: row.id,
          text: c.text,
          projectNum: c.project && c.project !== "General" ? c.project : null,
          author: c.author ?? null,
          date: dateOnly(c.date),
        })),
      );
      commentCount += s.comments.length;
    }
  }

  // ── Competitors ──
  const [coll] = await db
    .insert(competitorCollections)
    .values({ name: "Linear Lighting", description: "Linear lighting competitor tracker" })
    .returning();

  if (COMPETITOR_DATA.length) {
    await db.insert(competitors).values(
      COMPETITOR_DATA.map((b) => ({
        collectionId: coll.id,
        name: b.name,
        website: b.website,
        parent: b.parent,
        tierKey: b.tierKey,
        tier: b.tier,
        segment: b.segment,
        country: b.country,
        productLines: b.productLines,
        channel: b.channel,
        notes: b.notes,
        capabilities: b.capabilities ?? [],
      })),
    );
  }

  console.log(
    `Done. Inserted ${supplierCount} suppliers, 0 project entries, ${commentCount} comments. ${COMPETITOR_DATA.length} competitors in collection "${coll.name}".`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Shared list of job roles offered as a quick-pick in the Admin panel.
// Picked from "what a typical small/mid-size manufacturer or construction
// company has on payroll". Free text is also accepted (the column is
// just `text`), but the dropdown nudges admins toward consistent labels
// so we can report on them later.

export const JOB_ROLES = [
  // Leadership
  "CEO",
  "COO",
  "CFO",
  "CTO",
  "President",
  "VP",
  "Director",
  "General Manager",
  // Operations / production
  "Operations Manager",
  "Project Manager",
  "Procurement",
  "Buyer",
  "Logistics",
  "Warehouse",
  "Warehouse Manager",
  "Quality / QC",
  "Production",
  "Production Manager",
  "Foreman",
  // Engineering / technical
  "Engineering",
  "Engineering Manager",
  "Designer",
  "Drafter",
  "R&D",
  // Sales / commercial
  "Sales",
  "Sales Manager",
  "Account Manager",
  "Customer Service",
  // Back office
  "Finance",
  "Accounting",
  "HR",
  "IT",
  "Marketing",
  "Administration",
  // Catch-all
  "Other",
] as const;

export type JobRole = (typeof JOB_ROLES)[number];

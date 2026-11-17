/**
 * Budapest's districts are named "VII. kerület" in OpenStreetMap; residents know most of them
 * by their official names too (Erzsébetváros). Districts without an official name (II, XIII,
 * XV, XVI) are shown by number only.
 */
const OFFICIAL_NAMES: Record<string, string> = {
  I: "Budavár",
  III: "Óbuda-Békásmegyer",
  IV: "Újpest",
  V: "Belváros-Lipótváros",
  VI: "Terézváros",
  VII: "Erzsébetváros",
  VIII: "Józsefváros",
  IX: "Ferencváros",
  X: "Kőbánya",
  XI: "Újbuda",
  XII: "Hegyvidék",
  XIV: "Zugló",
  XVII: "Rákosmente",
  XVIII: "Pestszentlőrinc-Pestszentimre",
  XIX: "Kispest",
  XX: "Pesterzsébet",
  XXI: "Csepel",
  XXII: "Budafok-Tétény",
  XXIII: "Soroksár",
};

export interface DistrictLabel {
  /** Roman numeral, or null when the OSM name carries none (e.g. test fixtures). */
  numeral: string | null;
  /** Official name, or null for numbered-only districts (the numeral says it all). */
  name: string | null;
  /** The name as stored in OpenStreetMap ("VII. kerület"). */
  osmName: string;
}

export function districtLabel(osmName: string): DistrictLabel {
  const numeral = /^([IVXL]+)\.\s/.exec(osmName)?.[1] ?? null;
  return { numeral, name: numeral ? (OFFICIAL_NAMES[numeral] ?? null) : osmName, osmName };
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX", "XXI", "XXII", "XXIII"];

/**
 * Budapest postcodes are 1DDx, where DD is the district (1065 -> VI). An address knows its
 * district exactly, unlike a 170 m hexagon on a district border.
 */
export function districtFromPostcode(text: string | null | undefined): string | null {
  const dd = /\b1(\d\d)\d\b/.exec(text ?? "")?.[1];
  const n = dd ? Number(dd) : 0;
  return n >= 1 && n <= 23 ? `${ROMAN[n - 1]}. kerület` : null;
}

/** "VI. kerület · Terézváros", or just the OSM name when there is no official name. */
export function districtLine(osmName: string): string {
  const { name } = districtLabel(osmName);
  return name && name !== osmName ? `${osmName} · ${name}` : osmName;
}

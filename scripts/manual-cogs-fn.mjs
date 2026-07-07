export function manualUnitCost(rawName) {
  const n = rawName.toLowerCase().trim();

  // ---- non-product / unmatched ----
  if (n === 'na' || n === 'return') return { unit_cost: 0, note: 'placeholder/not a product' };
  if (/^mega\s*offer/.test(n)) return { unit_cost: 0, note: 'Mega Offer not in product_costs' };
  if (/maroon plush blanket/.test(n)) return { unit_cost: 0, note: 'Plush blanket not in product_costs' };

  // ---- Quilted Bedspread Sets (all colors/variants @ 1860) ----
  // Catches: "BEIGE QUILTED BEDSPREAD SET(flower) - King", "OFF-WHITE QUILTED BEDSPREAD SET",
  //          lowercase variants, all paren-suffix variants (flower/lines/check/diamond design).
  if (/quilted\s*bedspread/.test(n)) return { unit_cost: 1860, note: 'Quilted Bedspread Set family' };

  // Loose "X bedspread set" without "quilted" — same family.
  if (/^(beige|black|grey|gray|navy|maroon|plum|teal|off[-\s]?white|red)\s+bedspread\s+set/.test(n))
    return { unit_cost: 1860, note: 'bedspread set (loose form)' };

  // Generic "maroon bedspread set" / "teal bedspread set and grey bedspread set"
  // Composite "Teal bedspread set and grey bedspread set" → 2 items, but the order
  // line was qty=1 for "the whole thing"; treat as 2 × 1860.
  if (/teal bedspread set and grey bedspread set/.test(n))
    return { unit_cost: 3720, note: 'composite: teal+grey bedspread' };

  if (/^maroon bedspread set/.test(n)) return { unit_cost: 1860, note: 'maroon bedspread' };

  // ---- Bedspread / Bedsheet / Duvet Bundles ----
  // (b) variants always have 3 colors with " / " separators (3 segments).
  // (a) variants have 2 colors. The unqualified "Bedspread Bundle - X / Y" we treat as (a).
  if (/bedspread bundle/.test(n)) {
    if (/\(b\)/.test(n)) return { unit_cost: 5580, note: 'Bedspread Bundle (b)' };
    return { unit_cost: 3720, note: 'Bedspread Bundle (a)' };
  }
  if (/bedsheet bundle/.test(n)) {
    if (/\(b\)/.test(n)) return { unit_cost: 3600, note: 'Bedsheet Bundle (b)' };
    // "bedsheet bundle grey/ beige / maroon" — 3 colors → (b)
    const segs = n.split('/').length;
    if (segs >= 3) return { unit_cost: 3600, note: 'Bedsheet Bundle (b) by 3 segments' };
    return { unit_cost: 2400, note: 'Bedsheet Bundle (a)' };
  }
  if (/duvet bundle/.test(n)) {
    if (/\(b\)/.test(n)) return { unit_cost: 5400, note: 'Duvet Bundle (b)' };
    // "Duvet Bundle  Maroon / Black" missing tier label — only 2 colors → (a)
    const segs = n.split('/').length;
    if (segs >= 3) return { unit_cost: 5400, note: 'Duvet Bundle (b) by 3 segments' };
    return { unit_cost: 3600, note: 'Duvet Bundle (a)' };
  }

  // ---- Color Bundles ----
  // Beige Bundle / Black Bundle / Grey Bundle / Navy Bundle / Maroon Bundle / Off-white Bundle
  if (/(beige|black|grey|navy|maroon|off[-\s]?white)\s*bundle/.test(n)) {
    if (/\(a\)/.test(n)) {
      return { unit_cost: 5710, note: 'Color Bundle (a)' };
    }
    if (/\(b\)/.test(n)) {
      if (/off[-\s]?white/.test(n)) return { unit_cost: 4000, note: 'Off-White Bundle (b)' };
      return { unit_cost: 4860, note: 'Color Bundle (b)' };
    }
    // No tier specified — assume (a)
    return { unit_cost: 5710, note: 'Color Bundle, default (a)' };
  }

  // ---- Pajama Sets (all 1500) ----
  if (/pajama|pj set|cord set/.test(n)) {
    // composite line "navy pajama set piping wala medium size ] [ black pajama set..." → 2 items
    if (/(\]\s*\[|piping wala medium size.*black pajama)/.test(n))
      return { unit_cost: 3000, note: 'composite: 2 pajama sets' };
    // "navy pink black pajama set in medium size" → 3 items
    if (/navy pink black pajama/.test(n))
      return { unit_cost: 4500, note: 'composite: 3 pajamas' };
    // "black and navy pajama set" → 2 items
    if (/black and navy pajama/.test(n))
      return { unit_cost: 3000, note: 'composite: 2 pajamas' };
    return { unit_cost: 1500, note: 'pajama set family' };
  }

  // ---- Towels (all 850) ----
  if (/100%\s*cotton\s*towel/.test(n)) return { unit_cost: 850, note: 'cotton towel' };
  if (/embroider(ed|ey)\s*towel|emnroidered\s*towel|mr\s*and\s*mrs.*towel/.test(n))
    return { unit_cost: 850, note: 'embroidered towel set' };

  // ---- Striped Bed Sheets (all 1200) ----
  if (/striped\s+\w+\s*(bed\s*sheet|sheet|bedsheet)/.test(n))
    return { unit_cost: 1200, note: 'striped bedsheet family' };
  if (/^striped\s+(grey|navy|maroon|beige|off|white|green|black)/.test(n))
    return { unit_cost: 1200, note: 'striped bedsheet (loose)' };

  // ---- Loose bedsheet sets (all 1200) ----
  if (/^(navy|black|bold black|beige|maroon|plum)\s*(blue\s*)?(bedsheet|bed\s*sheet)/.test(n))
    return { unit_cost: 1200, note: 'plain bedsheet set' };
  if (/^bold black bedsheet/.test(n)) return { unit_cost: 1200, note: 'bold black bedsheet' };
  if (/^off\s*white\s*bedsheet/.test(n)) return { unit_cost: 1200, note: 'off-white bedsheet' };
  if (/^evergreen bedsheet/.test(n)) return { unit_cost: 1200, note: 'evergreen bedsheet' };
  if (/^bold black bedsheet set/.test(n)) return { unit_cost: 1200, note: 'bold black bedsheet set' };

  // ---- 6 PCS sets ----
  // Special cases first (different cost than the 3060 majority).
  if (/^maroon\s*6\s*pcs\s*set\s*$/.test(n) || n === 'maroon 6 pcs set')
    return { unit_cost: 1860, note: 'MAROON 6 PCS SET (no qualifier) = 1860' };
  if (/navy\s*bedset\s*6\s*pcs|^navy\s*bedset$/.test(n))
    return { unit_cost: 1860, note: 'NAVY BEDSET 6 PCS = 1860' };
  if (/off[-\s]?white\s*6\s*pcs\s*set\s*\(\s*lines\s*\)/.test(n))
    return { unit_cost: 1860, note: 'OFF-WHITE 6 PCS SET(lines) = 1860' };
  if (n === 'plum 6 pcs set') return { unit_cost: 1200, note: 'PLUM 6 PCS SET (no qualifier) = 1200' };
  // All other 6 PCS / striped 6 PCS / bedset variants → 3060
  if (/6\s*pcs|6\s*pieces|striped\s*6\s*pcs/.test(n))
    return { unit_cost: 3060, note: '6 PCS family default' };
  if (/^off\s*white\s*bedset|^off\s*white\s*6/.test(n))
    return { unit_cost: 3060, note: 'off-white bedset' };
  if (/^beige\s*bedset/.test(n))
    return { unit_cost: 3060, note: 'beige bedset' };
  if (/(beige|navy)\s*bed\s*set\s*\(white\)/.test(n))
    return { unit_cost: 1200, note: 'BEIGE BED SET (white) = 1200' };
  if (n === 'beige bed set (white)') return { unit_cost: 1200, note: 'BEIGE BED SET (white)' };

  // ---- Duvet Cover Sets ----
  // Beige / Grey / Off-white: bag=3000, with-filling=7000, plain duvet=1800
  // Black / Navy: all variants 3200
  // Maroon: all variants 1800
  if (/duv\w*\s*cover\s*set|duvet\s*cover\s*set/.test(n) || /duvet cover/.test(n)) {
    const isBlack = /^black/.test(n);
    const isNavy  = /^navy/.test(n) || /^navy blue/.test(n);
    const isMaroon = /^(maroon|marron)/.test(n);
    const isBeige = /^beige/.test(n);
    const isGrey  = /^grey/.test(n);
    const isOffWh = /^off[-\s]?white/.test(n);

    const withFilling = /with\s*filling/.test(n);
    const bedInBag    = /bed\s*in\s*(a\s*)?bag/.test(n) && !withFilling;
    const plainDuvet  = !bedInBag && !withFilling;

    if (isBlack || isNavy) return { unit_cost: 3200, note: 'Black/Navy duvet cover set (any variant)' };
    if (isMaroon)          return { unit_cost: 1800, note: 'Maroon duvet cover set (any variant)' };

    if (withFilling) return { unit_cost: 7000, note: 'Beige/Grey/Off-white duvet bed-in-bag with filling' };
    if (bedInBag)    return { unit_cost: 3000, note: 'Beige/Grey/Off-white duvet bed-in-a-bag' };
    return { unit_cost: 1800, note: 'Beige/Grey/Off-white duvet cover set (plain)' };
  }
  // catch-all bare "duvet cover set" without color
  if (n === 'duvet cover set') return { unit_cost: 1800, note: 'plain duvet cover set' };

  // ---- Specialty / single-product items ----
  if (/crystal\s*embroidered\s*set/.test(n))   return { unit_cost: 4000, note: 'Crystal Embroidered Set' };
  if (/mattress\s*topper/.test(n))             return { unit_cost: 3200, note: 'Mattress Topper' };
  if (/pillow\s*filling/.test(n))              return { unit_cost: 1000, note: 'Pillow Filling' };
  if (/duvet\s*filling/.test(n))               return { unit_cost: 5000, note: 'Duvet Filling' };
  if (/silk\s*embroidered\s*pillows/.test(n))  return { unit_cost: 1500, note: 'Silk Embroidered Pillows' };
  if (/accessories\s*bundle/.test(n))          return { unit_cost: 3900, note: 'Accessories Bundle' };
  if (/^the\s*orbit/.test(n))                  return { unit_cost: 1500, note: 'The Orbit accessory' };
  if (/trendy\s*table\s*place[-\s]?mats/.test(n)) return { unit_cost: 1500, note: 'Place-mats' };
  if (/^purple\s*bed\s*set/.test(n))           return { unit_cost: 3060, note: 'Purple Bed Set' };
  if (/^evergreen/.test(n) && /6\s*pcs/.test(n)) return { unit_cost: 3060, note: 'Evergreen 6 PCS' };

  // ---- Composite freeform descriptions ----
  // "(Embroidered set Grey bedset with duvet Mr mrs towel)"
  if (/embroidered set.*grey bedset.*duvet.*mr.*mrs.*towel/.test(n))
    return { unit_cost: 4000 + 3060 + 1800 + 850, note: 'composite: crystal+grey6pcs+duvet+towel' };

  // "1 - off white bedspread set x flat bedsheet set - 6pcs" / similar
  if (/off white bedspread set.*flat bedsheet set.*6pcs/.test(n))
    return { unit_cost: 1860 + 3060, note: 'composite: bedspread+6pcs' };

  // "off white bedspread set x off white duvet cover set"
  if (/off white bedspread set.*off white duvet cover set/.test(n))
    return { unit_cost: 1860 + 1800, note: 'composite: bedspread+duvet' };

  // "- Offwhite bedspread and duvet set Maroon bedspread with bedsheet White bedsheet )"
  if (/offwhite bedspread and duvet set maroon bedspread with bedsheet white bedsheet/.test(n))
    return { unit_cost: 1860 + 1800 + 1860 + 1200 + 1200, note: 'composite freeform' };

  // The huge composite "one navy blue bedsheet … one pink pj set s-m"
  if (/one navy blue bedsheet.*one pink pj set/.test(n))
    return { unit_cost: 1200 + 3200 + 1200 + 1860 + 1200 + 3200 + 1500 + 1500, note: 'composite of 8' };

  // Parsing artifact: "1 x BEIGE QUILTED BEDSPREAD SET(flower) - King ]" — same as the standard one
  if (/1\s*x\s*beige quilted bedspread set/.test(n))
    return { unit_cost: 1860, note: 'parsing artifact - quilted bedspread' };

  return { unit_cost: 0, note: `UNMATCHED: ${rawName}` };
}


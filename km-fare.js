/* ---------------------------------------------------------------------------
 * Airport transfers priced by road distance, for an address the zone tables
 * do not cover. Agreed with Aman on 19 Oct 2026.
 *
 * The zone tables stay the price wherever they have one. This table is only
 * the fallback for a place that is not on the suburb list, or one that is on
 * it but has no fare from that particular airport (Toowoomba to OOL, say).
 *
 * Where the numbers came from: every listed suburb's road distance to each
 * airport (data/suburb-facts.json on the website repo) against its published
 * fare - 752 pairs. Each 10 km band was set at the upper part of what listed
 * places in that band already pay, then smoothed so it never falls as the
 * distance grows. Past about 180 km, where nothing is listed, a Sedan adds $25
 * per 10 km and the larger vehicles a little more, because a long one-way run
 * means the same distance back empty.
 *
 * Known and accepted (Aman, 19 Oct 2026): the hinterland, Sunshine Coast and
 * Toowoomba fares are set by drive time rather than distance, so an unlisted
 * address right beside Tamborine Mountain, Eumundi or Toowoomba quotes $40-75
 * under the listed town. Those bookings say "Priced by distance" in the
 * office email so they can be seen.
 *
 * Over 300 km is not priced online: the customer sends a request instead.
 * The 18-seater column is the Sprinter 14 x 1.20, rounded up to the next $5,
 * the same rule as the zone tables (Aman, 3 Nov 2026).
 * ------------------------------------------------------------------------ */
const BAND_KM = 10;
const MAX_KM = 300;
/* One row per 10 km band (0-10, 10-20 ... 290-300). Columns in VEHICLES
   order: Sedan, SUV, People Mover, Luxury Sedan, Luxury Minivan,
   Mercedes Sprinter 10-Seater, Mercedes Sprinter 14-Seater,
   Mercedes Sprinter 18-Seater. */
const KM_RATES = [
  [85, 95, 100, 110, 115, 175, 245, 295],
  [105, 115, 125, 135, 140, 205, 280, 340],
  [125, 140, 145, 155, 165, 235, 315, 380],
  [140, 155, 160, 175, 180, 260, 340, 410],
  [160, 175, 185, 195, 205, 290, 375, 450],
  [185, 200, 210, 225, 235, 320, 415, 500],
  [210, 225, 240, 250, 260, 355, 455, 550],
  [230, 250, 260, 275, 285, 385, 485, 585],
  [250, 270, 280, 295, 310, 415, 520, 625],
  [265, 285, 300, 310, 325, 440, 550, 660],
  [280, 300, 315, 330, 345, 465, 575, 690],
  [300, 320, 340, 350, 370, 495, 610, 735],
  [320, 345, 360, 375, 390, 525, 645, 775],
  [345, 370, 385, 400, 420, 560, 680, 820],
  [370, 395, 415, 430, 450, 595, 720, 865],
  [395, 420, 440, 455, 475, 625, 760, 915],
  [420, 445, 470, 485, 505, 660, 800, 960],
  [445, 475, 495, 510, 535, 695, 835, 1005],
  [470, 500, 520, 540, 560, 730, 875, 1050],
  [495, 525, 550, 565, 590, 765, 915, 1100],
  [520, 550, 575, 595, 620, 800, 950, 1140],
  [545, 575, 605, 620, 645, 835, 990, 1190],
  [570, 605, 630, 650, 675, 870, 1030, 1240],
  [595, 630, 655, 675, 705, 905, 1065, 1280],
  [620, 655, 685, 700, 730, 940, 1105, 1330],
  [645, 680, 710, 730, 760, 970, 1145, 1375],
  [670, 705, 740, 755, 790, 1005, 1185, 1425],
  [695, 735, 765, 785, 815, 1040, 1220, 1465],
  [720, 760, 790, 810, 845, 1075, 1260, 1515],
  [745, 785, 820, 840, 875, 1110, 1300, 1560],
];

/* The fare for a road distance and a vehicle column, or null: no distance,
   over 300 km, or a vehicle without a column. Exactly 300 km
   is still the last band; 300.1 km is not priced. */
function kmFare(km, vi) {
  if (!Number.isFinite(km) || km < 0 || km > MAX_KM) return null;
  const row = KM_RATES[Math.min(KM_RATES.length - 1, Math.floor(km / BAND_KM))];
  const f = row && row[vi];
  return Number.isFinite(f) ? f : null;
}

module.exports = { KM_RATES, BAND_KM, MAX_KM, kmFare };

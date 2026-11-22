import {
  CivicCategory,
  EXPANDED_CIVIC_CATEGORIES,
  mapExpandedToLegacyCategory,
} from '../types/civic';

export interface CivicIssueEducationGuide {
  id: string;
  category: CivicCategory;
  subTypes: string[];
  title: string;
  whatItIs: string;
  whyItHappens: string[];
  publicAndEnvironmentalImpact: string[];
  potentialRisks: string[];
  howCitizensHelp: string[];
  appropriateMunicipalActions: string[];
  practicalTips: string[];
  riskDisclaimer: string;
}

export const CIVIC_ISSUE_EDUCATION_GUIDES: CivicIssueEducationGuide[] = [
  {
    id: 'edu-garbage',
    category: 'Garbage',
    subTypes: ['Garbage dumping', 'Waste accumulation', 'Overflowing bins', 'Roadside litter'],
    title: 'Garbage Dumping & Overflowing Bins',
    whatItIs:
      'Uncollected household refuse, spilled commercial packaging, or overflowing public waste receptacles accumulating on streets, sidewalks, or vacant plots.',
    whyItHappens: [
      'Missed or irregular waste collection vehicle schedules in high-density corridors.',
      'Undersized or damaged street bins filling up faster than their scheduled emptying cycle.',
      'Illegal dumping of unsegregated bags outside designated door-to-door pickup hours.',
    ],
    publicAndEnvironmentalImpact: [
      'Generates foul odors and visual blight across pedestrian walkways and residential entrances.',
      'Loose plastics and wrappers wash into storm drains during rain, contributing to street flooding.',
      'Mixed wet-and-dry dumping reduces the recyclability of paper, cardboard, and plastics.',
    ],
    potentialRisks: [
      'Accumulated organic and stagnant waste may attract flies, rodents, and stray animals that can spread sanitation-related illnesses.',
      'Open burning of uncollected garbage piles can release irritating smoke and fine particulates affecting respiratory comfort.',
    ],
    howCitizensHelp: [
      'Separate kitchen wet waste, clean dry recyclables, and domestic hazardous items at home before handover.',
      'Avoid placing loose bags beside a full bin; report overflowing receptacles promptly with a clear location landmark.',
      'Use covered containers until door-to-door collection arrives.',
    ],
    appropriateMunicipalActions: [
      'Dispatch sanitation collection crew to clear piled waste and empty overflowing bins.',
      'Sweep and sanitize the affected roadside stretch and repair or upgrade bin capacity.',
      'Adjust pickup route frequency at chronic dumping corners.',
    ],
    practicalTips: [
      'Photograph the full bin or waste pile from the sidewalk without stepping into traffic.',
      'Include the shop name or pole number near chronic black spots so sweepers locate it faster.',
    ],
    riskDisclaimer:
      'Health and environmental impacts vary depending on waste composition, local weather, and duration of accumulation.',
  },
  {
    id: 'edu-pothole',
    category: 'Pothole',
    subTypes: ['Pothole', 'Road cracks', 'Damaged roads', 'Surface cave-in'],
    title: 'Potholes, Road Cracks & Damaged Carriageways',
    whatItIs:
      'Depressions, alligator cracking, crumbling asphalt edges, or structural cavities in paved streets where traffic and water have weakened the road surface.',
    whyItHappens: [
      'Rainwater seeping into small unsealed hairline cracks weakens the compacted gravel sub-base underneath.',
      'Repeated heavy axle loads from buses, tankers, and freight trucks flex weakened pavement.',
      'Utility trench cuts for cables or pipes that were not properly compacted and resurfaced.',
    ],
    publicAndEnvironmentalImpact: [
      'Slows traffic flow, increases fuel consumption from sudden braking, and creates rough commuting conditions.',
      'Loosened gravel and dust become airborne particulate matter in dry weather.',
      'Unclear lane obstacles force vehicles to swerve unpredictably around damaged patches.',
    ],
    potentialRisks: [
      'Sudden wheel drops may pose skidding, tire, or balance hazards, particularly for two-wheelers, cyclists, and pedestrians at night.',
      'Water-filled potholes can hide their actual depth from oncoming motorists and pedestrians.',
    ],
    howCitizensHelp: [
      'Report early cracks and small depressions before monsoon rains expand them into major craters.',
      'Note whether the crater lies near a junction, school zone, or bus stop for priority traffic safety attention.',
      'Never step into active vehicle lanes solely to take a closer photograph.',
    ],
    appropriateMunicipalActions: [
      'Install temporary safety cones or warning reflectors around deep hazards.',
      'Cut, clean, prime, and patch the cavity using cold-mix or hot-mix bitumen/concrete restoration.',
      'Inspect underlying drainage or water pipes if repeated sinking occurs at the same spot.',
    ],
    practicalTips: [
      'Take one wide photo showing a stationary reference (curb or sidewalk) so engineers can judge width safely from the pavement.',
    ],
    riskDisclaimer:
      'Traffic hazard severity depends on road speed, lighting, crater depth, and weather conditions.',
  },
  {
    id: 'edu-drainage',
    category: 'Drainage',
    subTypes: ['Drainage', 'Blocked drains', 'Sewage overflow', 'Waterlogging', 'Choked storm grate'],
    title: 'Blocked Drains, Sewage Overflow & Waterlogging',
    whatItIs:
      'Clogged stormwater grates, backed-up open channels, overflowing sewer manholes, or standing surface water unable to drain into municipal lines.',
    whyItHappens: [
      'Discarded plastic bags, bottles, construction silt, and fallen leaves matting inside catch basins.',
      'Solidified cooking oil and grease narrowing underground sewer pipes.',
      'Damaged or collapsed drain slabs obstructing normal flow during heavy rainfall.',
    ],
    publicAndEnvironmentalImpact: [
      'Causes localized road waterlogging that disrupts pedestrian movement and public transit.',
      'Can seep into unpaved soil, weaken road foundations, and create persistent odor issues in residential streets.',
      'Carries surface oil, litter, and untreated runoff toward local lakes and waterways.',
    ],
    potentialRisks: [
      'Standing water or sewage overflow may increase exposure to waterborne contaminants or create breeding conditions for mosquitoes.',
      'Submerged road surfaces can conceal open grates, missing manhole covers, or uneven pavement edges.',
    ],
    howCitizensHelp: [
      'Never sweep household trash, garden clippings, or cooking oil into street grates or kitchen drains.',
      'Keep sand and renovation gravel covered away from roadside gutters.',
      'Immediately flag missing manhole covers or active overflow as High Severity.',
    ],
    appropriateMunicipalActions: [
      'Deploy desilting and high-pressure jetting / super-sucker vehicles to clear blockages.',
      'Inspect, secure, or replace damaged drain grates and missing manhole covers.',
      'Flush affected street stretches once drainage flow is restored.',
    ],
    practicalTips: [
      'Avoid walking or driving through deep turbid water or active sewage overflow.',
      'Mention whether water is backing up continuously or only after rain.',
    ],
    riskDisclaimer:
      'Sanitation and contamination risks depend on whether the standing water is rainwater runoff or mixed sewer effluent.',
  },
  {
    id: 'edu-water-leakage',
    category: 'Water Leakage',
    subTypes: ['Water leakage', 'Burst pipe', 'Valve leak', 'Pipeline seepage'],
    title: 'Water Pipeline Leakage & Supply Wastage',
    whatItIs:
      'Continuous dripping, surface pooling, or pressurized water spraying from public distribution mains, street standposts, or underground valve chambers.',
    whyItHappens: [
      'Aging metallic or PVC distribution joints corroding or loosening under pressure fluctuations.',
      'Accidental strikes during nearby excavation or heavy vehicle vibration above shallow pipes.',
      'Worn rubber gaskets inside street valve pits.',
    ],
    publicAndEnvironmentalImpact: [
      'Wastes treated municipal drinking water and energy used for purification and pumping.',
      'Lowers tap pressure for downstream homes on the same supply line.',
      'Continuous saturation softens asphalt sub-bases, accelerating pothole and sinkhole formation.',
    ],
    potentialRisks: [
      'Back-siphonage at broken underground joints during low-pressure hours may increase the risk of supply contamination.',
      'Constant wet pavement and algae growth can make sidewalks and intersections slippery.',
    ],
    howCitizensHelp: [
      'Report active street leaks promptly with the nearest house number, pole number, or cross-street.',
      'Report whether the flow is continuous throughout the day or appears only during morning/evening supply hours.',
    ],
    appropriateMunicipalActions: [
      'Isolate the local distribution valve to minimize potable water loss.',
      'Excavate carefully, clamp or replace the damaged pipe section, and pressure-test the joint.',
      'Coordinate road surface reinstatement after repair.',
    ],
    practicalTips: [
      'Specify if water appears clean (likely supply line) or discolored/odorous (possible drain cross-leakage).',
    ],
    riskDisclaimer:
      'Underground pipe failure causes can only be confirmed after municipal valve inspection and excavation.',
  },
  {
    id: 'edu-streetlight',
    category: 'Broken Streetlight',
    subTypes: ['Broken streetlight', 'Dark street stretch', 'Damaged pole', 'Flickering lamp'],
    title: 'Broken Streetlights & Public Lighting Faults',
    whatItIs:
      'Non-functional, flickering, tilted, or physically damaged public LED poles, overhead junction boxes, or dark pedestrian corridors.',
    whyItHappens: [
      'Moisture intrusion inside luminaire drivers, blown feeder fuses, or loose pole-base wiring.',
      'Storm winds or vehicle impacts bending poles or dislodging overhead brackets.',
      'Timer/photocell sensor malfunction keeping stretches dark at night.',
    ],
    publicAndEnvironmentalImpact: [
      'Reduces nighttime visibility along sidewalks, bus stops, and crosswalks.',
      'Creates uneven shadows on roads, making potholes and pedestrians harder for drivers to spot.',
    ],
    potentialRisks: [
      'Dimly lit corridors may heighten trip-and-fall risks and reduce perceived personal safety after dusk.',
      'Exposed, hanging, or sparked pole wiring may pose an electrical hazard—keep a safe distance and avoid touching metal poles in wet weather.',
    ],
    howCitizensHelp: [
      'Note the pole identification number painted on the post (if visible) or count how many consecutive lights are out.',
      'Report leaning poles or dangling wires as High Severity immediately without touching anything.',
    ],
    appropriateMunicipalActions: [
      'Dispatch electrical maintenance bucket crew to test feeder phase, photocell switch, and luminaire driver.',
      'Secure exposed wiring covers, straighten damaged brackets, or replace faulty LED fixtures.',
    ],
    practicalTips: [
      'Daytime photos of broken/tilted fixtures or dusk photos showing dark stretches both help electrical crews verify the exact pole.',
    ],
    riskDisclaimer:
      'Always treat exposed electrical cables or tilted metal poles with caution and stay clear until qualified technicians inspect them.',
  },
  {
    id: 'edu-other-infra',
    category: 'Other',
    subTypes: [
      'Damaged footpaths',
      'Fallen trees',
      'Damaged public infrastructure',
      'Damaged traffic signs',
      'Damaged public property',
      'Needs Review',
    ],
    title: 'Damaged Footpaths, Fallen Trees & Public Property',
    whatItIs:
      'Broken sidewalk slabs, uprooted or fallen tree branches, bent or missing traffic signs, damaged park benches/railings, and other public civic assets needing repair.',
    whyItHappens: [
      'Severe storms, high winds, or root heave cracking interlocking footpath tiles.',
      'Vehicle collisions or wear-and-tear bending street signage, bollards, and railings.',
      'Settlement of utility trench covers along pedestrian walkways.',
    ],
    publicAndEnvironmentalImpact: [
      'Forces pedestrians—including children, older adults, and wheelchair users—onto active vehicle lanes.',
      'Fallen limbs block carriageways, transit lanes, and access to emergency corridors.',
      'Missing or obscured regulatory traffic signs reduce driver compliance at intersections.',
    ],
    potentialRisks: [
      'Uneven or missing footpath slabs create tripping hazards for pedestrians.',
      'Fallen trees resting near overhead power cables may carry hidden electrical or structural collapse hazards.',
    ],
    howCitizensHelp: [
      'Keep clear of downed limbs near overhead wires and alert neighbors to detour safely.',
      'Upload clear daytime photos showing the damaged sidewalk, fallen branch, or broken sign with a landmark.',
    ],
    appropriateMunicipalActions: [
      'Place temporary barricades or reflective warning tape around broken walkways or fallen obstructions.',
      'Clear fallen green debris safely (coordinating with electrical utility if wires are involved) and compost/mulch timber.',
      'Re-lay footpath pavers, straighten traffic signs, and repair damaged public railings.',
    ],
    practicalTips: [
      'Mention if a wheelchair ramp, school crossing, or hospital entrance is blocked so crews can prioritize clearance.',
    ],
    riskDisclaimer:
      'Structural stability or electrical involvement around fallen trees or damaged poles must be verified on-site by trained crews.',
  },
];

const SUBTYPE_KEYWORD_MAP: Array<{ keywords: string[]; category: CivicCategory }> = [
  { keywords: ['pothole', 'crack', 'road', 'asphalt', 'crater'], category: 'Pothole' },
  { keywords: ['garbage', 'trash', 'waste', 'litter', 'bin', 'dumping', 'rubbish'], category: 'Garbage' },
  { keywords: ['drain', 'sewage', 'sewer', 'manhole', 'clog', 'waterlogging', 'stagnant', 'flood'], category: 'Drainage' },
  { keywords: ['water', 'leak', 'pipe', 'tap', 'burst', 'valve'], category: 'Water Leakage' },
  { keywords: ['light', 'lamp', 'bulb', 'pole', 'street', 'dark'], category: 'Broken Streetlight' },
];

export function getEducationGuideForCategory(
  category?: string | null,
  subType?: string | null
): CivicIssueEducationGuide {
  if (category) {
    const exact = CIVIC_ISSUE_EDUCATION_GUIDES.find((g) => g.category === category);
    if (exact) return exact;

    const normalizedInput = category.trim().toLowerCase();
    const isExpandedCategory = EXPANDED_CIVIC_CATEGORIES.some(
      (exp) => exp.toLowerCase() === normalizedInput
    );
    if (isExpandedCategory) {
      const mappedLegacy = mapExpandedToLegacyCategory(category);
      const mappedGuide = CIVIC_ISSUE_EDUCATION_GUIDES.find((g) => g.category === mappedLegacy);
      if (mappedGuide) return mappedGuide;
    }
  }

  const combined = `${category || ''} ${subType || ''}`.toLowerCase();
  for (const entry of SUBTYPE_KEYWORD_MAP) {
    if (entry.keywords.some((kw) => combined.includes(kw))) {
      const found = CIVIC_ISSUE_EDUCATION_GUIDES.find((g) => g.category === entry.category);
      if (found) return found;
    }
  }

  return CIVIC_ISSUE_EDUCATION_GUIDES[CIVIC_ISSUE_EDUCATION_GUIDES.length - 1];
}

/**
 * CiviFix AI - Curated Civic Intelligence & Awareness Knowledge Base
 *
 * Provides accurate, practical, and step-by-step civic guidance covering:
 * - Waste segregation & recycling (2-Bin 1-Bag guidelines)
 * - Door-to-door municipal collection routines
 * - Garbage overflow and neighborhood dumping
 * - Road potholes, craters, and sidewalk hazards
 * - Water supply pipeline leaks and valve bursts
 * - Blocked stormwater drains, culverts, and monsoon flooding
 * - Broken, dark, or flickering streetlights
 * - Public cleanliness and citizen hygiene responsibilities
 * - Step-by-step complaint submission via "+ Report"
 * - Step-by-step complaint tracking via "My Reports"
 * - Helpful clarification for ambiguous civic requests
 * - Friendly boundaries for unrelated non-civic questions
 *
 * NOTE: Never invents false ticket numbers, official phone numbers, or municipal guarantees.
 */

export type CivicIntent =
  | 'waste_segregation'
  | 'garbage_collection'
  | 'garbage_overflow'
  | 'potholes_roads'
  | 'water_leakage'
  | 'drainage_flooding'
  | 'streetlights'
  | 'public_cleanliness'
  | 'complaint_submission'
  | 'report_tracking'
  | 'clarification'
  | 'unrelated';

export interface CivicKnowledgeEntry {
  id: string;
  category: string;
  keywords: string[];
  title: string;
  answer: string;
  intent: CivicIntent;
  suggestedAction?: 'report' | 'my_reports' | null;
}

export const CIVIC_KNOWLEDGE_ENTRIES: CivicKnowledgeEntry[] = [
  {
    id: 'waste_segregation',
    category: 'Waste Management',
    keywords: [
      'segregate', 'segregation', 'waste', 'bin', 'bins', 'wet waste', 'dry waste',
      'recycle', 'recycling', '2-bin', '2 bin', 'green bin', 'blue bin', 'red bag',
      'household waste', 'waste management', 'segregate waste', 'how to segregate'
    ],
    title: 'Waste Segregation (2-Bin 1-Bag System)',
    intent: 'waste_segregation',
    suggestedAction: 'report',
    answer:
`Under Standard Municipal Waste Segregation Guidelines:

• Green Bin (Wet Waste):
  - Biodegradable kitchen waste: fruit & vegetable peels, food leftovers, coffee grounds, eggshells, and garden clippings.
  - Important: Do not wrap wet waste in polythene bags. Use newspaper or compostable lining.

• Blue Bin (Dry Recyclables):
  - Recyclables: Clean paper, flattened cardboard cartons, plastic containers, beverage bottles, glass bottles, and metal cans.
  - Tip: Rinse food residues from plastic containers and cartons before disposing. Keep dry.

• Red Bag (Hazardous & Sanitary):
  - Sanitary items: Diapers, napkins, bandages.
  - Domestic hazardous: Expired medicines, broken glass, insecticide cans, and small batteries.
  - Wrap sanitary waste securely in newspaper marked with a red cross.

• E-Waste:
  - Old phones, chargers, cables, and appliances should not be mixed with regular garbage. Drop them off at designated ward e-waste collection centers.`,
  },
  {
    id: 'waste_ewaste',
    category: 'E-Waste Management',
    keywords: [
      'e-waste', 'ewaste', 'electronic waste', 'electronics', 'old phone', 'phone',
      'charger', 'chargers', 'cable', 'cables', 'battery', 'batteries', 'laptop',
      'computer', 'appliances', 'gadgets', 'gadget', 'circuit board', 'appliance',
      'discard phone', 'electronic disposal', 'dispose electronic'
    ],
    title: 'Electronic Waste (E-Waste) Disposal Guidelines',
    intent: 'waste_segregation',
    suggestedAction: 'report',
    answer:
`Electronic Waste (E-Waste) Safe Disposal Guidelines:

1. Never Mix E-Waste with Household Garbage:
   - Discarded electronics (old phones, chargers, USB cables, laptops, remote controls, circuit boards) contain hazardous heavy metals including lead, cadmium, and mercury.
   - Do NOT throw them into regular Green (wet) or Blue (dry) household bins.

2. Authorized Ward E-Waste Drop-Off Centers:
   - Deposit electronics at designated municipal ward collection kiosks or authorized producer responsibility e-drop centers.
   - Many municipal wards host scheduled monthly e-waste collection drives where citizens can safely deposit broken electronics.

3. Personal Data & Battery Safety:
   - Perform a factory reset and remove SIM/memory cards from phones or laptops before disposal.
   - If a lithium battery is swollen or leaking, seal it in an individual plastic bag before transport to avoid fire hazard.`,
  },
  {
    id: 'waste_plastic_recycling',
    category: 'Recyclables Management',
    keywords: [
      'plastic', 'plastics', 'plastic bottle', 'bottles', 'cardboard', 'carton',
      'cartons', 'paper', 'tetra pack', 'metal can', 'cans', 'rinse', 'dry recyclables',
      'plastic container', 'beverage bottle', 'tin', 'tins', 'recyclable', 'recyclables',
      'is this recyclable', 'is it recyclable', 'what is recyclable'
    ],
    title: 'Dry Recyclables & Plastics Management (Blue Bin)',
    intent: 'waste_segregation',
    suggestedAction: 'report',
    answer:
`Dry Recyclables & Plastic Waste Management (Blue Bin):

1. What Goes into the Blue Bin:
   - Clean paper, newspaper, magazines, and flattened cardboard cartons.
   - Rinsed plastic containers (beverage bottles, milk pouches, shampoo/detergent bottles).
   - Metal soda cans, food tins, and dry aluminium foil.

2. Rinsing & Cleanliness Rule:
   - Rinse food residues, grease, or liquids from plastic containers and cartons before disposing.
   - Soiled, greasy food wrappers or oil packets contaminate entire batches of recyclables; rinse and let them dry before placing in the Blue Bin.

3. Flatten Cartons & Plastic Bottles:
   - Crush plastic bottles and flatten cardboard cartons to save bin volume and streamline transport for municipal recycling units.`,
  },
  {
    id: 'waste_kitchen_compost',
    category: 'Wet Waste Management',
    keywords: [
      'kitchen waste', 'food scraps', 'peels', 'vegetable peels', 'fruit peels',
      'vegetable', 'compost', 'composting', 'coffee grounds', 'eggshells',
      'tea leaves', 'garden waste', 'organic waste', 'food leftovers'
    ],
    title: 'Wet Waste & Composting (Green Bin)',
    intent: 'waste_segregation',
    suggestedAction: 'report',
    answer:
`Wet Biodegradable Kitchen Waste Guidelines (Green Bin):

1. What Goes into the Green Bin:
   - Fruit and vegetable peels, leftover cooked food, eggshells, coffee grounds, and tea leaves.
   - Plate scrapings, wilted flowers, and small garden clippings.

2. No Polythene Bag Liners:
   - Never tie or wrap wet waste inside non-biodegradable polythene bags.
   - Line your kitchen bin with newspaper, banana leaves, or certified compostable bags.

3. Home Composting Tip:
   - Kitchen scraps can easily be converted into rich garden compost using an aerated household composting pot.
   - Layer wet greens (fruit/vegetable peels) with dry browns (dry leaves, shredded newspaper, or cocopeat) in a 1:1 ratio to prevent foul odors.`,
  },
  {
    id: 'waste_hazardous_sanitary',
    category: 'Domestic Hazardous Waste',
    keywords: [
      'sanitary', 'diaper', 'diapers', 'napkin', 'sanitary pads', 'bandages',
      'expired medicine', 'medicines', 'broken glass', 'insecticide', 'pills',
      'blades', 'syringes', 'red bag', 'hazard bag'
    ],
    title: 'Domestic Hazardous & Sanitary Waste (Red Bag)',
    intent: 'waste_segregation',
    suggestedAction: 'report',
    answer:
`Domestic Hazardous & Sanitary Waste Disposal (Red Bag):

1. Sanitary Items (Wrap Securely):
   - Used diapers, sanitary pads, and medical bandages.
   - Always wrap sanitary items securely in multiple folds of newspaper or paper bags, and mark the package with a red cross (X) for sanitation worker safety.

2. Domestic Toxic & Sharp Hazards:
   - Expired medicines and blister pills (crush into newspaper before disposing; do not flush down drains).
   - Broken glass, razor blades, and box cutters (wrap thickly in cardboard to prevent puncture injuries to sanitation workers).
   - Insecticide aerosol cans and chemical disinfectants.`,
  },
  {
    id: 'waste_paper_cardboard',
    category: 'Recyclables Management',
    keywords: [
      'paper', 'cardboard', 'carton', 'cartons', 'newspaper', 'magazines',
      'corrugated box', 'boxes', 'shredded paper', 'tetra pack', 'dry paper'
    ],
    title: 'Paper & Cardboard Recycling Guidelines',
    intent: 'waste_segregation',
    suggestedAction: 'report',
    answer:
`Paper & Cardboard Recycling Best Practices (Blue Bin):

1. Clean & Dry Paper Recyclables:
   - Newspapers, office printer paper, study notebooks, cardboard packing boxes, and egg cartons.
   - Flatten cardboard cartons completely to maximize collection volume and simplify transport.

2. Unrecyclable Paper Notice:
   - Paper soiled with food grease, pizza boxes soaked with oil, or waxed paper cannot be pulped and must be discarded.
   - Shredded paper should be placed inside a transparent paper envelope so it does not scatter during collection.

3. Collection Routine:
   - Bundle newspapers and flat cartons with jute twine and hand them over during your ward's scheduled dry waste collection day, or take them to a neighborhood Dry Waste Collection Center (DWCC).`,
  },
  {
    id: 'waste_batteries',
    category: 'Hazardous Waste',
    keywords: [
      'battery', 'batteries', 'lithium', 'lithium-ion', 'alkaline', 'cell', 'cells',
      'button cell', 'rechargeable battery', 'leaking battery', 'swollen battery',
      'what about its battery', 'what about the battery'
    ],
    title: 'Safe Household Battery Disposal Guidelines',
    intent: 'waste_segregation',
    suggestedAction: 'report',
    answer:
`Safe Battery Handling & Disposal Guidelines:

1. Fire & Explosion Prevention:
   - Never throw alkaline, button-cell, or lithium-ion batteries into household wet (Green) or dry (Blue) bins.
   - Punctured or crushed lithium batteries ignite easily inside waste compactors and cause severe truck fires.

2. Terminal Taping Checklist:
   - Cover the positive and negative terminals of 9V, lithium, and button-cell batteries with transparent or electrical tape before disposal to prevent short circuits.
   - If a battery is swollen or leaking white residue, place it inside an individual ziplock bag.

3. Drop-Off Locations:
   - Deposit spent batteries into dedicated battery drop-boxes located at your Ward Office, metro stations, or participating consumer electronics stores.`,
  },
  {
    id: 'waste_home_composting',
    category: 'Wet Waste Management',
    keywords: [
      'home compost', 'home composting', 'compost at home', 'composting at home',
      'can i compost', 'compost pot', 'greens and browns', 'organic manure',
      'kitchen composting', 'compost bin', 'vermicompost'
    ],
    title: 'Home Composting: Step-by-Step Practical Guide',
    intent: 'waste_segregation',
    suggestedAction: 'report',
    answer:
`Step-by-Step Household Composting Guide:

1. Choose Your Composter:
   - Use an aerated terracotta stack (3-pot system) or a ventilated plastic bin with drainage holes.

2. The 1:1 Green & Brown Golden Rule:
   - Greens (Nitrogen-rich): Raw vegetable and fruit peels, tea leaves, coffee grounds, and eggshells.
   - Browns (Carbon-rich): Dry leaves, sawdust, shredded newspaper, or coco peat blocks.
   - Always cover fresh wet kitchen scraps with an equal layer of dry browns to trap moisture and prevent odors or fruit flies.

3. What NOT to Add:
   - Avoid cooked meat, fish bones, dairy products, oils, and pet feces in small indoor composters.

4. Harvesting Dark Gold:
   - Turn the pile once a week for aeration. In 45 to 60 days, the bottom pot transforms into crumbly, earthy-scented organic compost for your house plants.`,
  },
  {
    id: 'garbage_collection',
    category: 'Waste Management',
    keywords: [
      'collection', 'door to door', 'door-to-door', 'truck', 'van', 'morning',
      'pickup', 'schedule', 'timing', 'timings', 'sanitation worker', 'handover',
      'daily collection', 'garbage van', 'collector', 'sweeper', 'cart'
    ],
    title: 'Door-to-Door Waste Collection Routines',
    intent: 'garbage_collection',
    suggestedAction: 'report',
    answer:
`Daily Household Waste Collection Guidelines:

1. Collection Timings:
   - Municipal sanitation vehicles typically carry out door-to-door collection during scheduled morning hours.
   - Specific collection schedules vary by ward. Check your local Ward Office or Resident Welfare Association (RWA) notice board for exact neighborhood timings.

2. At-Source Segregation:
   - Keep your Green Bin (wet waste) and Blue Bin (dry recyclables) ready for handover.
   - Do not dump mixed waste into collection carts.

3. Bin Hygiene & Animal Prevention:
   - Keep household bins covered with tightly fitted lids to prevent stray dogs, cats, or birds from scavenging.
   - Never leave loose plastic bags on sidewalks outside collection hours.`,
  },
  {
    id: 'garbage_overflow',
    category: 'Sanitation & Waste',
    keywords: [
      'garbage', 'trash', 'pile', 'piles', 'piling', 'piling up', 'garbage pile',
      'pile of garbage', 'overflow', 'overflowing', 'dumping', 'dump', 'blackspot',
      'litter', 'stench', 'smell', 'bins full', 'full bin', 'garbage heap',
      'open dumping', 'trash dump', 'eyesore', 'stray animals', 'fly tipping'
    ],
    title: 'Reporting Overflowing Garbage & Dumping',
    intent: 'garbage_overflow',
    suggestedAction: 'report',
    answer:
`To report an overflowing community bin or illegal garbage dump:

1. Tap "+ Report" in the bottom menu of CiviFix AI.
2. Select "Garbage" as the category.
3. Take a clear photo showing the garbage pile, surrounding footpath, or overflowing bin.
4. Allow GPS location detection, or type the nearest street landmark (e.g., "Behind Market Gate #3").
5. Tap "Submit Report" to log the ticket into the municipal system for sanitation truck dispatch.

Safety Notice: Never burn open trash piles. Burning plastics and mixed waste releases carcinogenic dioxins, toxic smoke, and heavy particulates into neighborhood air.`,
  },
  {
    id: 'potholes_roads',
    category: 'Road Maintenance',
    keywords: [
      'pothole', 'potholes', 'road', 'roads', 'crater', 'craters', 'asphalt', 'tar',
      'hole', 'holes', 'big hole', 'hole in road', 'hole on road', 'road hole',
      'bump', 'bumps', 'sidewalk', 'pavement', 'crack', 'cracks', 'accident',
      'speedbreaker', 'broken road', 'damaged road', 'skid hazard', 'tarmac'
    ],
    title: 'Reporting Road Potholes & Cratering',
    intent: 'potholes_roads',
    suggestedAction: 'report',
    answer:
`To log a road hazard or pothole for municipal asphalt repair:

1. Tap "+ Report" in the bottom navigation bar.
2. Select "Pothole" as the issue category.
3. Choose severity:
   - Mark "High" if the crater is deep (>5 cm), in the primary vehicular lane, or poses an immediate skid/fall risk for two-wheelers.
   - Mark "Medium" or "Low" for shallow surface cracks or minor shoulder erosion.
4. Capture a clear photo showing the pothole relative to the street.
   Safety Reminder: Always step onto the pedestrian sidewalk or curb before taking photos. Never stand in live vehicle lanes.
5. Tap GPS to pinpoint the location or type the landmark (e.g., "Opposite Metro Pillar 142").
6. Tap "Submit Report" to receive your tracking ticket (CFX-2026-XXXX).`,
  },
  {
    id: 'water_leakage',
    category: 'Water Supply',
    keywords: [
      'water', 'leak', 'leaks', 'leakage', 'pipe', 'pipes', 'pipeline', 'burst',
      'drinking water', 'potable', 'valve', 'main line', 'flooding road',
      'gushing', 'water pipe', 'supply line', 'broken pipe', 'low pressure'
    ],
    title: 'Reporting Water Supply Pipeline Leaks',
    intent: 'water_leakage',
    suggestedAction: 'report',
    answer:
`To report a leaking municipal supply main, burst valve, or flooded drinking water pipe:

1. Tap "+ Report" in the bottom navigation bar.
2. Select "Water Leakage" as the category.
3. Describe the leak characteristics:
   - Mention whether clean drinking water is gushing under high pressure or pooling steadily from an underground pipe.
4. Pinpoint the location:
   - Provide the exact street corner, building number, or valve chamber landmark to help municipal plumbing crews trace the pipeline valve quickly.
5. Tap "Submit Report" to create the maintenance ticket.

Civic Impact: Prompt reporting conserves potable drinking water, prevents road subgrade erosion, and avoids water pressure loss across neighboring homes.`,
  },
  {
    id: 'drainage_flooding',
    category: 'Stormwater & Drainage',
    keywords: [
      'drain', 'drains', 'drainage', 'gutter', 'gutters', 'sewage', 'clog', 'clogged',
      'blocked', 'flood', 'flooding', 'waterlog', 'waterlogging', 'monsoon',
      'culvert', 'silt', 'stagnant', 'rainwater', 'manhole', 'mosquito'
    ],
    title: 'Blocked Drains, Gutter Chokes & Waterlogging',
    intent: 'drainage_flooding',
    suggestedAction: 'report',
    answer:
`To report blocked stormwater gutters, clogged culverts, or sewage overflows:

1. Tap "+ Report" in the bottom navigation bar.
2. Select "Drainage" as the category.
3. Specify the issue type:
   - Stormwater Blockage: Rainwater unable to drain from the street surface.
   - Sewage Overflow: Foul-smelling sewage backing up onto roadways or pedestrian paths.
4. Note stagnant water pools:
   - Standing water creates active mosquito breeding vectors for dengue, chikungunya, and malaria.
5. Tap "Submit Report" to notify municipal desilting and suction machine teams.

Civic Tip: Never sweep roadside mud, tree leaves, or plastic wrappers into stormwater gratings, as they cause severe underground culvert chokes during monsoon rains.`,
  },
  {
    id: 'streetlights',
    category: 'Public Lighting',
    keywords: [
      'streetlight', 'streetlights', 'street light', 'street lights', 'lamp', 'lamps',
      'dark', 'darkness', 'bulb', 'bulbs', 'pole', 'poles', 'flicker', 'flickering',
      'blackout', 'night', 'luminaire', 'light post', 'streetlamp'
    ],
    title: 'Reporting Broken or Dark Streetlights',
    intent: 'streetlights',
    suggestedAction: 'report',
    answer:
`To report a defective, dark, or flickering streetlight:

1. Tap "+ Report" in the bottom navigation bar.
2. Choose "Broken Streetlight" as the category.
3. Note the Pole Number:
   - Most municipal light poles have a stencil or metal tag (e.g., "LP-42" or "WD-12-08"). Including this allows electrical maintenance crews to locate the exact luminaire.
4. Landmark Description:
   - If no pole number is visible, describe the location clearly (e.g., "Third light pole east of Park Gate, near House 18").
5. Tap "Submit Report" to register the issue.

Safety Note: If you observe exposed live electrical wires or a leaning pole after a storm, report it immediately with "High" severity so emergency electrical crews are dispatched.`,
  },
  {
    id: 'public_cleanliness',
    category: 'Sanitation & Hygiene',
    keywords: [
      'cleanliness', 'clean', 'hygiene', 'littering', 'spitting', 'plastic ban',
      'etiquette', 'citizen duty', 'swachh', 'public health', 'urination',
      'cloth bag', 'community drive', 'civic duty', 'civic sense'
    ],
    title: 'Public Cleanliness, Sanitation & Citizen Duties',
    intent: 'public_cleanliness',
    suggestedAction: 'report',
    answer:
`Civic Practices for Neighborhood Cleanliness & Public Hygiene:

• Litter Disposal:
  - Always deposit food wrappers, cups, and beverage bottles into public street litter bins. If bins are unavailable nearby, carry wrappers until you reach home.

• Ban on Open Spitting & Urination:
  - Public spitting and wall defacement spread airborne pathogens and degrade public spaces. Use designated public sanitation facilities.

• Reduce Single-Use Plastics:
  - Carry reusable cloth or jute bags for shopping. Single-use plastic polybags are the leading cause of choked city drains and urban flooding.

• Community Participation:
  - Participate in neighborhood cleanliness drives organized by local resident associations and maintain clean frontages outside homes and shops.`,
  },
  {
    id: 'complaint_submission',
    category: 'CiviFix Guide',
    keywords: [
      'how to report', 'how do i report', 'file complaint', 'file a complaint',
      'lodge complaint', 'lodge a complaint', 'submit report', 'submit a report',
      'log issue', 'log an issue', 'create report', 'register complaint',
      'register issue', 'file an issue', 'new report', 'complaint'
    ],
    title: 'How to File an Official Civic Report in CiviFix AI',
    intent: 'complaint_submission',
    suggestedAction: 'report',
    answer:
`How to submit a civic issue report in CiviFix AI:

Important: The CiviFix Chatbot is an informational assistant and does not automatically file complaints from chat messages.

To file your report officially:
1. Tap "+ Report" on the bottom navigation bar.
2. Select the issue category (Garbage, Pothole, Water Leakage, Drainage, Broken Streetlight, or Other).
3. Enter a clear description of the problem.
4. (Optional) Attach a photo of the issue for municipal visual verification.
5. Tap the GPS button to detect coordinates, or enter the street address and nearest landmark.
6. Tap "Submit Report".

What happens next:
Your report is securely recorded in the municipal database and assigned an immutable tracking ID (e.g., CFX-2026-XXXX) for municipal tracking.`,
  },
  {
    id: 'report_tracking',
    category: 'CiviFix Guide',
    keywords: [
      'track', 'tracking', 'status', 'check status', 'track status', 'where is my report',
      'check progress', 'my reports', 'follow up', 'note', 'timeline', 'tracking number',
      'tracking id', 'resolved', 'in progress', 'under review', 'ticket'
    ],
    title: 'How to Track Your Reports & Check Status',
    intent: 'report_tracking',
    suggestedAction: 'my_reports',
    answer:
`How to track your submitted reports in CiviFix AI:

1. Tap "My Reports" on the bottom navigation bar.
2. You will see all reports filed under your authenticated citizen account, each with its current status:
   • Submitted: Report registered and queued for municipal triage.
   • Under Review: Department official reviewing issue details and severity.
   • In Progress: Field maintenance or repair crew assigned.
   • Resolved: Issue inspected and work completed.

3. Detailed Timeline & Updates:
   - Tap any report card to view its complete timestamped activity log, department notes, and assigned ward.
   - You can add citizen follow-up notes directly inside your report if conditions change.

Verifying Status Details:
CiviFix displays live status and timeline updates directly from your official report record. We do not invent estimated deadlines or resolution guarantees; please review your actual report in "My Reports" for official department updates.`,
  },
  {
    id: 'report_status_stages',
    category: 'CiviFix Guide',
    keywords: [
      'status stages', 'submitted status', 'under review status', 'in progress status',
      'resolved status', 'what does status mean', 'status meanings', 'stage',
      'how long will it take', 'how long does it take', 'how much time', 'timeline', 'timelines'
    ],
    title: 'Report Status Lifecycle: From Submission to Resolution',
    intent: 'report_tracking',
    suggestedAction: 'my_reports',
    answer:
`Understanding Your Report Status Stages:

1. Submitted:
   - Your complaint has been assigned a unique tracking number (e.g., CFX-2026-XXXX) and saved securely under your account. It is in the ward triage queue.

2. Under Review:
   - A municipal department officer or junior engineer has reviewed your description, location, and photo, and categorized the issue severity.

3. In Progress:
   - The task has been scheduled and assigned to a field crew (such as an asphalt patch team, sanitation truck, or electrical squad).

4. Resolved:
   - Field work has been completed and verified. Department resolution notes appear on your report card in "My Reports".`,
  },
  {
    id: 'complaint_escalation',
    category: 'CiviFix Guide',
    keywords: [
      'not resolved', 'nobody fixes it', 'nobody fixed', 'what if nobody fixes',
      'not fixed', 'unresolved', 'reopen', 're-open', 'escalate', 'escalation',
      'follow up process', 'follow-up process', 'explain the follow up process',
      'how to follow up', 'complaint follow-up'
    ],
    title: 'Complaint Follow-Up & Escalation Procedures',
    intent: 'report_tracking',
    suggestedAction: 'my_reports',
    answer:
`How to Follow Up or Escalate an Unresolved Issue:

1. Access Your Ticket in "My Reports":
   - Open the bottom menu, tap "My Reports", and select your pending complaint card.

2. Add a Citizen Follow-Up Note:
   - Tap "Add Note" on your report. Describe changes on the ground (e.g., "Pothole widened after heavy rains" or "Garbage accumulation spreading").
   - Attach fresh photo evidence so municipal supervisors can re-evaluate severity.

3. Resolution Verification:
   - If a report is marked "Resolved" but work was incomplete or inadequate, submit a note within 7 days. This flags the ticket for supervisor audit.

4. Escalating Beyond CiviFix AI:
   - Provide your official CFX-2026-XXXX tracking number during monthly Ward Committee meetings or to your Resident Welfare Association (RWA) representative for administrative intervention.`,
  },
  {
    id: 'civic_infrastructure',
    category: 'Civic Infrastructure',
    keywords: [
      'broken sidewalk', 'footpath', 'pavement', 'manhole', 'missing manhole',
      'manhole cover', 'open drain cover', 'tree branch', 'fallen tree', 'street sign',
      'damaged sign', 'kerb', 'pavement hazard'
    ],
    title: 'Reporting Damaged Sidewalks, Manholes & Infrastructure',
    intent: 'potholes_roads',
    suggestedAction: 'report',
    answer:
`Reporting Hazardous Sidewalks, Open Manholes & Obstructions:

1. High-Hazard Immediate Issues:
   - Open or missing manhole covers pose fatal hazards to pedestrians and cyclists, especially at night or during rain. Report these immediately with "High" severity.
   - Broken concrete pavement slabs, protruding iron rebar, or deep footpath collapses.

2. Fallen Trees & Storm Obstructions:
   - Fallen tree limbs or broken municipal road signs blocking traffic should be reported under "Other" with clear landmark landmarks.

3. Reporting Workflow:
   - Tap "+ Report", choose "Pothole" for pavement collapse or "Other" for manholes/trees, enable GPS, and submit.`,
  },
  {
    id: 'water_conservation',
    category: 'Resource Conservation',
    keywords: [
      'water conservation', 'save water', 'conserve water', 'drinking water waste',
      'water shortage', 'tap leak', 'rainwater harvesting'
    ],
    title: 'Urban Water Conservation & Leak Prevention',
    intent: 'water_leakage',
    suggestedAction: 'report',
    answer:
`Urban Water Conservation & Leak Prevention Best Practices:

1. Rapid Street Leak Reporting:
   - Underground water mains operate at 2 to 4 bar pressure. A minor burst pipeline can waste over 20,000 liters of treated drinking water in a single day.
   - Use "+ Report" $\to$ "Water Leakage" as soon as you spot clean water bubbling up on roads.

2. Household Conservation:
   - Install aerators on household taps to reduce water flow by 40% without compromising pressure.
   - Check domestic toilet cisterns and overhead tanks for silent overflow float valve leaks.

3. Rainwater Harvesting (RWH):
   - Rooftop rainwater harvesting replenishes localized groundwater aquifers and prevents municipal storm drains from overflowing during monsoon cloudbursts.`,
  },
  {
    id: 'road_safety',
    category: 'Civic Safety',
    keywords: [
      'road safety', 'taking photo safely', 'traffic danger', 'pedestrian safety',
      'safe reporting', 'taking photos', 'photo', 'photos', 'upload photo',
      'what photo should i upload', 'what photo to take', 'what photo should i take',
      'photo advice', 'picture', 'photograph', 'how to photograph'
    ],
    title: 'Citizen Road Safety & Photo Capture Guidelines',
    intent: 'potholes_roads',
    suggestedAction: 'report',
    answer:
`Citizen Road Safety & Photo Capture Protocol:

1. Never Stand in Live Vehicular Traffic:
   - When photographing potholes, waterlogged trenches, or dark streetlights, always stand safely on the pedestrian footpath or curb.
   - Never stop suddenly in the middle of a vehicular lane on a two-wheeler or car to take photos.

2. Optimal Photo Angles:
   - Capture a wide-angle perspective showing the hazard in relation to a recognizable street landmark (such as a shop board, building number, or light pole).
   - Daylight photos provide clear visual contrast for municipal repair crews.

3. Night-Time Reporting:
   - If photographing at night, ensure flash is active and wear reflective or light-colored clothing while near roadways.`,
  },
  {
    id: 'clarification',
    category: 'Civic Assistance',
    keywords: ['help', 'issue', 'problem', 'broken', 'assist', 'assistance', 'bad', 'something', 'fix', 'damage'],
    title: 'CiviFix Civic Assistant - Need Clarification',
    intent: 'clarification',
    suggestedAction: null,
    answer:
`I am the CiviFix Civic Assistant. I want to make sure I give you the exact guidance you need, but your query was a bit general.

Could you please specify which civic topic you need help with?

1. Waste Segregation & Recycling (Green / Blue / Red bin rules)
2. Garbage Overflow or Street Dumping
3. Potholes & Damaged Road Hazards
4. Clean Water Leaks & Pipeline Bursts
5. Blocked Drains, Gutters & Monsoon Flooding
6. Broken, Dark, or Flickering Streetlights
7. How to File a Report (step-by-step via "+ Report")
8. How to Track an Existing Report (via "My Reports")

Please type the topic or describe the specific problem on your street.`,
  },
  {
    id: 'unrelated',
    category: 'Civic Assistance',
    keywords: [],
    title: 'CiviFix Civic Assistant - Scope of Service',
    intent: 'unrelated',
    suggestedAction: null,
    answer:
`I am the CiviFix Civic Assistant, specifically designed to help citizens with municipal civic intelligence, neighborhood sanitation, and issue reporting.

I am unable to answer general knowledge questions, creative writing prompts, or non-civic inquiries.

I can help you with:
• Household waste segregation & recycling guidelines
• Guidance on reporting potholes, garbage dumps, water leaks, blocked drains, or dark streetlights
• Instructions on filing a new report ("+ Report") or tracking existing submissions ("My Reports")

Please ask a civic or municipal question, and I will be glad to assist you!`,
  },
];

// Common typo & variation mapping to canonical tokens
const COMMON_TYPO_MAP: Record<string, string> = {
  // Potholes & Hazards
  'pothol': 'pothole',
  'potholes': 'pothole',
  'pathole': 'pothole',
  'patholes': 'pothole',
  'pothles': 'pothole',
  'pot-hole': 'pothole',
  'pot hole': 'pothole',
  'pit': 'pothole',
  'hole': 'pothole',
  'holes': 'pothole',
  'crater': 'pothole',
  'craters': 'pothole',
  'asfalt': 'asphalt',
  'tarmac': 'asphalt',
  // Garbage / Waste
  'gargabe': 'garbage',
  'garbeg': 'garbage',
  'garbge': 'garbage',
  'gabage': 'garbage',
  'garbag': 'garbage',
  'trsh': 'trash',
  'rubish': 'rubbish',
  'rubbish': 'garbage',
  'kachra': 'garbage',
  'kudha': 'garbage',
  // E-Waste & Electronics
  'electrnic': 'ewaste',
  'electronics': 'ewaste',
  'ewaste': 'ewaste',
  'battry': 'battery',
  'batterys': 'battery',
  // Segregation
  'segregate': 'segregation',
  'segragate': 'segregation',
  'segeragate': 'segregation',
  'segregetion': 'segregation',
  'segreting': 'segregation',
  'segregating': 'segregation',
  'separate': 'segregation',
  'separating': 'segregation',
  // Recycling & Composting
  'recyle': 'recycle',
  'recycel': 'recycle',
  'recyclng': 'recycle',
  'recyclying': 'recycle',
  'recylable': 'recycle',
  'recyling': 'recycle',
  'compostng': 'compost',
  // Drainage
  'drane': 'drainage',
  'dranage': 'drainage',
  'drainge': 'drainage',
  'drinage': 'drainage',
  'drains': 'drainage',
  'gutter': 'drainage',
  'gutters': 'drainage',
  'culvert': 'drainage',
  'sewage': 'drainage',
  'waterlog': 'waterlogging',
  'water-logging': 'waterlogging',
  'waterlogging': 'drainage',
  'flooding': 'flood',
  'flooded': 'flood',
  // Water Leakage
  'leek': 'leak',
  'leeking': 'leak',
  'leekage': 'leak',
  'leakage': 'leak',
  'pipline': 'pipeline',
  'pipe': 'pipe',
  'pipes': 'pipe',
  'watr': 'water',
  // Streetlight
  'stretlight': 'streetlight',
  'stree light': 'streetlight',
  'streelight': 'streetlight',
  'streetlght': 'streetlight',
  'streetlights': 'streetlight',
  'stretlights': 'streetlight',
  'lamppost': 'streetlight',
  'lamp post': 'streetlight',
  // Reporting / Tracking
  'complat': 'complaint',
  'complint': 'complaint',
  'compalint': 'complaint',
  'complain': 'complaint',
  'complian': 'complaint',
  'grievance': 'complaint',
  'traking': 'tracking',
  'trake': 'tracking',
  'trak': 'tracking',
  'staus': 'status',
  'statas': 'status',
};

// General vague civic words that imply civic context but lack domain specificity
const VAGUE_CIVIC_WORDS = new Set([
  'help', 'issue', 'problem', 'broken', 'assist', 'assistance', 'bad',
  'road', 'street', 'city', 'complaint', 'fix', 'report', 'area',
  'neighborhood', 'damage', 'hazard', 'civic', 'something', 'anything'
]);

// Stop words to exclude from primary token scoring
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'it', 'to', 'for', 'of',
  'on', 'at', 'by', 'with', 'from', 'as', 'and', 'or', 'so', 'be', 'do', 'does',
  'did', 'can', 'could', 'would', 'should', 'i', 'me', 'my', 'we', 'our', 'you',
  'your', 'they', 'them', 'their', 'this', 'that', 'there', 'what', 'where',
  'when', 'why', 'how', 'who', 'please', 'tell', 'want', 'know', 'give'
]);

/**
 * Computes Levenshtein edit distance between two strings.
 */
function getLevenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  let currRow = new Array(b.length + 1);

  for (let i = 0; i < a.length; i++) {
    currRow[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      currRow[j + 1] = Math.min(
        currRow[j] + 1,
        prevRow[j + 1] + 1,
        prevRow[j] + cost
      );
    }
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }
  return prevRow[b.length];
}

/**
 * Normalizes user input and searches the civic knowledge base.
 * Employs multi-word phrase matching, typo tolerance, intent detection,
 * contextual history awareness for follow-ups, clarification for ambiguous inputs,
 * and polite fallback for out-of-scope queries.
 */
export function searchCivicKnowledge(
  query: string,
  history?: Array<{ sender?: string; text?: string }>
): CivicKnowledgeEntry | null {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return null;
  }

  const cleanQuery = query.toLowerCase().trim();
  const rawTokens = cleanQuery
    .split(/[^a-zA-Z0-9]+/)
    .filter((w) => w.length > 1);

  // If user only entered non-letter characters
  if (rawTokens.length === 0) {
    return null;
  }

  const normalizedClean = cleanQuery.replace(/[^a-zA-Z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();

  // 1. History and Multi-Turn Conversational Resolution
  if (Array.isArray(history) && history.length > 0) {
    let historyContext = '';
    for (let i = history.length - 1; i >= 0; i--) {
      const itemText = (history[i]?.text || '').toLowerCase();
      if (itemText) {
        historyContext += ' ' + itemText;
        if (historyContext.length > 800) break;
      }
    }

    // Score domains against conversation history to pick the genuine active context
    const domainScores: Record<string, number> = {
      water_leakage: 0,
      potholes: 0,
      ewaste: 0,
      plastic_recycling: 0,
      kitchen_compost: 0,
      waste_segregation: 0,
      drainage: 0,
      streetlights: 0,
      garbage_overflow: 0,
      report_tracking: 0,
    };

    if (historyContext.includes('water leak') || historyContext.includes('pipeline') || historyContext.includes('pipe burst') || historyContext.includes('underground pipe')) {
      domainScores.water_leakage += 20;
    }
    if (historyContext.includes('water') && (historyContext.includes('leak') || historyContext.includes('pipe') || historyContext.includes('valve') || historyContext.includes('drinking water') || historyContext.includes('potable'))) {
      domainScores.water_leakage += 12;
    }

    if (historyContext.includes('pothole') || historyContext.includes('potholes') || historyContext.includes('crater') || historyContext.includes('craters') || historyContext.includes('road crater') || historyContext.includes('big hole') || historyContext.includes('hole on my road')) {
      domainScores.potholes += 20;
    }
    if (historyContext.includes('road') && (historyContext.includes('asphalt') || historyContext.includes('hole') || historyContext.includes('crater') || historyContext.includes('patch'))) {
      domainScores.potholes += 10;
    }

    if (historyContext.includes('e-waste') || historyContext.includes('ewaste') || historyContext.includes('old phone')) {
      domainScores.ewaste += 20;
    }
    if (historyContext.includes('phone') || historyContext.includes('battery') || historyContext.includes('charger') || historyContext.includes('electronic') || historyContext.includes('laptop')) {
      domainScores.ewaste += 10;
    }

    if (historyContext.includes('garbage pile') || historyContext.includes('garbage overflow') || historyContext.includes('overflowing bin') || historyContext.includes('piling up near my house') || historyContext.includes('piling up')) {
      domainScores.garbage_overflow += 20;
    }
    if (historyContext.includes('garbage') || historyContext.includes('trash') || historyContext.includes('dumping') || historyContext.includes('blackspot') || historyContext.includes('tipper truck')) {
      domainScores.garbage_overflow += 12;
    }

    if (historyContext.includes('blue bin') || historyContext.includes('dry recyclable') || historyContext.includes('dry recyclables')) {
      domainScores.plastic_recycling += 20;
    }
    if (historyContext.includes('plastic bottle') || historyContext.includes('carton') || historyContext.includes('recycling')) {
      domainScores.plastic_recycling += 10;
    }

    if (historyContext.includes('home compost') || historyContext.includes('composting') || historyContext.includes('kitchen waste') || historyContext.includes('food waste')) {
      domainScores.kitchen_compost += 20;
    }
    if (historyContext.includes('peels') || historyContext.includes('green bin') || historyContext.includes('food scraps')) {
      domainScores.kitchen_compost += 10;
    }

    if (historyContext.includes('segregat') || historyContext.includes('2-bin') || historyContext.includes('wet waste') || historyContext.includes('dry waste')) {
      domainScores.waste_segregation += 15;
    }

    if (historyContext.includes('clogged drain') || historyContext.includes('blocked drain') || historyContext.includes('stormwater drain') || historyContext.includes('monsoon flooding') || historyContext.includes('gutter')) {
      domainScores.drainage += 20;
    }
    if (historyContext.includes('culvert') || historyContext.includes('waterlogging') || historyContext.includes('desilting')) {
      domainScores.drainage += 10;
    }

    if (historyContext.includes('streetlight') || historyContext.includes('streetlights') || historyContext.includes('lamp post') || historyContext.includes('dark street') || historyContext.includes('light pole')) {
      domainScores.streetlights += 20;
    }

    if (historyContext.includes('my reports') || historyContext.includes('tracking') || historyContext.includes('cfx-')) {
      domainScores.report_tracking += 12;
    }

    let activeDomain:
      | 'potholes'
      | 'ewaste'
      | 'plastic_recycling'
      | 'kitchen_compost'
      | 'waste_segregation'
      | 'water_leakage'
      | 'drainage'
      | 'streetlights'
      | 'garbage_overflow'
      | 'report_tracking'
      | null = null;

    let bestScore = 0;
    for (const [dom, score] of Object.entries(domainScores)) {
      if (score > bestScore) {
        bestScore = score;
        activeDomain = dom as any;
      }
    }

    // A. "How can I complain about this?" / "How do I complain about it?" / "How to report this?"
    if (
      normalizedClean.includes('complain about this') ||
      normalizedClean.includes('complain about it') ||
      normalizedClean.includes('how can i complain') ||
      normalizedClean.includes('how do i complain') ||
      normalizedClean.includes('how to report this') ||
      normalizedClean.includes('how do i report this') ||
      normalizedClean.includes('how to report it') ||
      normalizedClean.includes('how do i report it') ||
      normalizedClean.includes('how can i report it') ||
      normalizedClean.includes('how can i report this') ||
      normalizedClean.includes('how can i report') ||
      normalizedClean === 'how to report' ||
      normalizedClean === 'how do i report'
    ) {
      if (activeDomain === 'potholes') {
        return CIVIC_KNOWLEDGE_ENTRIES.find((e) => e.id === 'potholes_roads') || null;
      }
      if (activeDomain === 'garbage_overflow') {
        return CIVIC_KNOWLEDGE_ENTRIES.find((e) => e.id === 'garbage_overflow') || null;
      }
      if (activeDomain === 'water_leakage') {
        return CIVIC_KNOWLEDGE_ENTRIES.find((e) => e.id === 'water_leakage') || null;
      }
      if (activeDomain === 'drainage') {
        return CIVIC_KNOWLEDGE_ENTRIES.find((e) => e.id === 'drainage_flooding') || null;
      }
      if (activeDomain === 'streetlights') {
        return CIVIC_KNOWLEDGE_ENTRIES.find((e) => e.id === 'streetlights') || null;
      }
    }

    // B. "What should I do before handing it over?" (E-Waste checklist)
    if (
      normalizedClean.includes('before handing') ||
      normalizedClean.includes('before giving') ||
      normalizedClean.includes('before discarding') ||
      normalizedClean.includes('before dropping')
    ) {
      if (activeDomain === 'ewaste' || normalizedClean.includes('phone') || normalizedClean.includes('electronic')) {
        return {
          id: 'waste_ewaste_checklist',
          category: 'E-Waste Management',
          keywords: ['checklist', 'handover', 'privacy', 'ewaste'],
          title: 'E-Waste Handover Checklist: Data Privacy & Safety',
          intent: 'waste_segregation',
          suggestedAction: 'report',
          answer:
`Checklist Before Handing Over Old Electronics:

1. Personal Data Backup & Factory Reset:
   - Back up personal photos, contacts, and documents to cloud storage or a computer.
   - Perform a complete Factory Data Reset to erase saved passwords, biometrics, and browsing sessions.

2. Eject Physical Cards & Accessories:
   - Remove your SIM card and micro-SD memory cards.
   - Remove protective plastic or silicone phone cases (cases can go into the Blue Bin if non-electronic).

3. Battery Inspection:
   - Check if the device battery is swollen, bulging, or leaking. If damaged, seal the phone inside a separate zip-lock bag before taking it to the e-waste collection center.

4. Bundle Cables & Adapters:
   - Wrap charging cords and power bricks together using a twist-tie so they can be recycled alongside the device.`,
        };
      }
    }

    // C. "What about its battery?" / "Can I throw the battery?"
    if (
      normalizedClean.includes('its battery') ||
      normalizedClean.includes('the battery') ||
      normalizedClean.includes('about battery') ||
      normalizedClean.includes('throw battery') ||
      normalizedClean.includes('dispose battery')
    ) {
      return CIVIC_KNOWLEDGE_ENTRIES.find((e) => e.id === 'waste_batteries') || null;
    }

    // D. "What goes into the blue bin?" / "What can I put in blue bin?"
    if (
      normalizedClean.includes('blue bin') &&
      (normalizedClean.includes('goes into') || normalizedClean.includes('what goes') || normalizedClean.includes('what can i put'))
    ) {
      return CIVIC_KNOWLEDGE_ENTRIES.find((e) => e.id === 'waste_plastic_recycling') || null;
    }

    // E. "Can I put food waste there?" (Food contamination in recyclables)
    if (
      (normalizedClean.includes('food') || normalizedClean.includes('kitchen') || normalizedClean.includes('peels')) &&
      (normalizedClean.includes('there') || normalizedClean.includes('blue bin') || normalizedClean.includes('dry bin'))
    ) {
      return {
        id: 'waste_blue_bin_no_food',
        category: 'Waste Segregation',
        keywords: ['food', 'blue bin', 'contamination', 'wet waste'],
        title: 'Why Food Waste Must Never Enter the Blue Bin',
        intent: 'waste_segregation',
        suggestedAction: 'report',
        answer:
`Food Waste Must NEVER Be Placed in the Blue Bin:

1. Severe Batch Contamination:
   - The Blue Bin is reserved strictly for clean, dry recyclables (paper, cardboard cartons, rinsed plastic bottles, and metal tins).
   - Food waste, grease, sauces, and liquids immediately soak into paper and cardboard, ruining entire recycling batches and causing municipal recycling facilities to reject them for landfill dumping.

2. Where Food Waste Belongs:
   - Always place food scraps, vegetable and fruit peels, tea leaves, and leftovers into your Green Bin (Wet Biodegradable).
   - Never wrap food waste in plastic bags; use newspaper or compostable lining.

3. Home Composting Alternative:
   - Food scraps and vegetable peels can easily be converted into rich organic compost right at home using an aerated potting system.`,
      };
    }

    // F. "Can I compost it at home?" / "Can I compost food waste?"
    if (
      normalizedClean.includes('compost it at home') ||
      normalizedClean.includes('compost at home') ||
      normalizedClean.includes('can i compost') ||
      normalizedClean.includes('home compost')
    ) {
      return CIVIC_KNOWLEDGE_ENTRIES.find((e) => e.id === 'waste_home_composting') || null;
    }

    // G. "What info should I provide?" / "What details should I provide?"
    if (
      normalizedClean.includes('what info') ||
      normalizedClean.includes('what details') ||
      normalizedClean.includes('what information')
    ) {
      if (activeDomain === 'water_leakage') {
        return {
          id: 'water_leak_info_checklist',
          category: 'Water Supply',
          keywords: ['checklist', 'water', 'info'],
          title: 'Information Needed When Reporting Water Leaks',
          intent: 'water_leakage',
          suggestedAction: 'report',
          answer:
`Key Information to Provide When Reporting a Water Leak:

1. Exact Location & Landmark:
   - Street name, nearest building number, or visible municipal valve box landmark.
   - Use the in-app GPS pin so pipeline maintenance teams can locate the leak quickly.

2. Photo & Water Flow Characteristics:
   - Take a clear photo showing whether clean water is bubbling under pressure, pooling on the road, or gushing from an exposed valve.

3. Road & Property Hazards:
   - Note if the water is undermining road asphalt (creating sinkhole hazards) or threatening to flood residential basements.

4. Water Type:
   - Clarify if it is clear potable drinking water or murky drainage/sewage backflow.`,
        };
      }
      if (activeDomain === 'potholes') {
        return {
          id: 'pothole_info_checklist',
          category: 'Road Maintenance',
          keywords: ['checklist', 'pothole', 'info'],
          title: 'Information Needed When Reporting a Road Pothole',
          intent: 'potholes_roads',
          suggestedAction: 'report',
          answer:
`Key Information to Provide When Reporting a Road Pothole:

1. Exact Street Location:
   - GPS coordinates and nearest street landmark (e.g., opposite Metro Pillar, near crossing).

2. Safe Photo:
   - Photograph the crater from the safe pedestrian sidewalk or curb, showing the hole width and depth relative to the street.

3. Severity Rating:
   - Select "High" if crater depth exceeds 5 cm or creates an urgent skid risk for two-wheelers.`,
        };
      }
    }

    // H. "What photo should I take?" / "What photo should I upload?"
    if (
      normalizedClean.includes('what photo') ||
      normalizedClean.includes('photo should i take') ||
      normalizedClean.includes('photo should i upload') ||
      normalizedClean.includes('how to take photo') ||
      normalizedClean.includes('photo to upload')
    ) {
      if (activeDomain === 'garbage_overflow') {
        return {
          id: 'garbage_photo_guide',
          category: 'Waste Management',
          keywords: ['photo', 'garbage', 'picture'],
          title: 'Photographing Garbage Accumulation Safely & Effectively',
          intent: 'garbage_overflow',
          suggestedAction: 'report',
          answer:
`Guidelines for Photographing Garbage Accumulation:

1. Wide-Angle Perspective:
   - Stand at a safe distance and capture a wide shot showing the full extent and volume of the accumulated waste.

2. Include Surrounding Landmarks:
   - Ensure a recognizable background landmark is visible (such as a shop signboard, building gate, or street pole) to help the tipper truck driver pinpoint the spot.

3. Road & Drain Proximity:
   - Show whether the trash pile is blocking vehicle traffic or spilling into stormwater drains.

4. Daylight & Safety:
   - Photograph in good daylight whenever possible, and never step into live vehicular lanes.`,
        };
      }
      return CIVIC_KNOWLEDGE_ENTRIES.find((e) => e.id === 'road_safety') || null;
    }

    // I. "What if nobody fixes it?" / "What if it is not resolved?"
    if (
      normalizedClean.includes('nobody fixes') ||
      normalizedClean.includes('no one fixes') ||
      normalizedClean.includes('not resolved') ||
      normalizedClean.includes('not fixed') ||
      normalizedClean.includes('nobody comes') ||
      normalizedClean.includes('follow up process') ||
      normalizedClean.includes('how to follow up')
    ) {
      return CIVIC_KNOWLEDGE_ENTRIES.find((e) => e.id === 'complaint_escalation') || null;
    }

    // J. "How long will it take?" / "How long does it take?"
    if (
      normalizedClean.includes('how long does it take') ||
      normalizedClean.includes('how long will it take') ||
      normalizedClean.includes('how much time') ||
      normalizedClean.includes('how many days') ||
      normalizedClean === 'how long'
    ) {
      if (activeDomain === 'potholes') {
        return {
          id: 'potholes_timeline',
          category: 'Road Maintenance',
          keywords: ['timeline', 'duration', 'pothole'],
          title: 'Road Pothole – Repair Timeline & Priority Matrix',
          intent: 'potholes_roads',
          suggestedAction: 'my_reports',
          answer:
`Municipal Pothole Repair Turnaround & Timelines:

1. Priority Inspection (24 to 72 Hours):
   - High-hazard deep craters (>5 cm depth or in main vehicular lanes) receive emergency inspection by ward engineers within 24 to 48 hours.
   - Immediate temporary measures (cold-mix asphalt patching or safety barricading) are implemented to protect two-wheelers and pedestrians.

2. Standard Maintenance Cycle (3 to 7 Days):
   - Shallow surface craters and shoulder erosion are batched into routine asphalt resurfacing schedules during dry weather.

3. Tracking in CiviFix AI:
   - Track live ticket progression in "My Reports". If road hazards worsen after heavy rainfall, add a citizen follow-up note with fresh photos.`,
        };
      }
      if (activeDomain === 'garbage_overflow') {
        return {
          id: 'garbage_timeline',
          category: 'Waste Management',
          keywords: ['timeline', 'garbage'],
          title: 'Garbage Overflow – Resolution Timeline',
          intent: 'garbage_overflow',
          suggestedAction: 'my_reports',
          answer:
`Garbage Overflow Clearance Timelines:

1. Inspection & Triage:
   - Logged overflow reports are reviewed by ward health inspectors within 24 hours.

2. Collection & Clearance:
   - Routine community bin overflows and blackspot dumps are scheduled for tipper truck clearance within 24 to 48 hours.

3. Real-Time Tracking:
   - Check "My Reports" for live status updates as sanitation squads complete neighborhood clearance.`,
        };
      }
      return CIVIC_KNOWLEDGE_ENTRIES.find((e) => e.id === 'report_status_stages') || null;
    }

    // K. "How do I check repair status?" / "How can I track it?"
    if (
      normalizedClean.includes('check repair status') ||
      normalizedClean.includes('track it') ||
      normalizedClean.includes('how to check status') ||
      normalizedClean.includes('check status') ||
      normalizedClean.includes('where is my report')
    ) {
      return CIVIC_KNOWLEDGE_ENTRIES.find((e) => e.id === 'report_tracking') || null;
    }

    // L. "Where can I take my old phone?" / "Where do I take them?" / "Where can I drop them?"
    if (
      normalizedClean.includes('where can i take') ||
      normalizedClean.includes('where do i take') ||
      normalizedClean.includes('where can i drop') ||
      normalizedClean.includes('where to drop') ||
      normalizedClean.includes('where do i drop')
    ) {
      if (activeDomain === 'ewaste' || normalizedClean.includes('phone') || normalizedClean.includes('electronic')) {
        return {
          id: 'waste_ewaste_followup',
          category: 'E-Waste Management',
          keywords: ['followup', 'ewaste', 'dropoff'],
          title: 'E-Waste – Finding Authorized Ward Drop-Off Points',
          intent: 'waste_segregation',
          suggestedAction: 'report',
          answer:
`Where and How to Drop Off Electronic Waste:

1. Finding Your Nearest Ward Drop-Off Point:
   - Visit your local Municipal Ward Office or citizen facilitation center, which houses permanent e-waste collection receptacles.
   - Authorized consumer electronics retail stores and brand service centers also provide drop boxes under Extended Producer Responsibility (EPR) programs.

2. Preparation Checklist:
   - Remove memory cards and SIM cards; perform a factory data reset on mobile devices and laptops.
   - Wrap any cracked or leaking batteries in individual plastic pouches to prevent contact with other items.

3. Heavy Appliances:
   - For bulky electronics (televisions, washing machines, refrigerators), schedule a doorstep collection through your ward's authorized recycling partner rather than transporting them yourself.`,
        };
      }
    }

    // M. Conversational follow-ups (what next, what happens after submit, tell me more, etc.)
    const isFollowUpPattern =
      normalizedClean === 'what next' ||
      normalizedClean === 'what should i do next' ||
      normalizedClean === 'what to do next' ||
      normalizedClean === 'what after that' ||
      normalizedClean === 'tell me more' ||
      normalizedClean === 'explain more' ||
      normalizedClean === 'can you explain more' ||
      normalizedClean === 'more details' ||
      normalizedClean === 'can you give more details' ||
      normalizedClean === 'how to proceed' ||
      normalizedClean === 'how do i do that' ||
      normalizedClean === 'what happens next' ||
      normalizedClean === 'can you explain' ||
      normalizedClean.includes('after i submit') ||
      normalizedClean.includes('after submission') ||
      normalizedClean.includes('what happens after') ||
      normalizedClean.startsWith('tell me more about') ||
      normalizedClean.startsWith('what about') ||
      normalizedClean.startsWith('can you explain');

    if (isFollowUpPattern) {
      if (activeDomain === 'potholes') {
        return {
          id: 'potholes_roads_followup',
          category: 'Road Maintenance',
          keywords: ['followup', 'next', 'timeline'],
          title: 'Road Pothole – Repair Timeline & Tracking Next Steps',
          intent: 'potholes_roads',
          suggestedAction: 'my_reports',
          answer:
`Next Steps for Your Reported Road Pothole:

1. Municipal Inspection Timeline:
   - Municipal road maintenance engineers typically review and inspect reported road craters within 48 to 72 hours.
   - Deep hazardous potholes (>5 cm) on primary roads are prioritized for cold-mix asphalt patching or temporary safety barricading.

2. Tracking Progress in CiviFix AI:
   - Navigate to "My Reports" at the bottom of the screen to view live status updates (Submitted → Under Review → In Progress → Resolved).
   - Once field repair workers are assigned, department notes and work verification updates appear on your report card.

3. If Pothole Severity Worsens:
   - If monsoon rain or heavy vehicular traffic causes the pothole to expand, tap your report in "My Reports" to submit an updated citizen follow-up note.`,
        };
      }

      if (activeDomain === 'ewaste') {
        return {
          id: 'waste_ewaste_followup',
          category: 'E-Waste Management',
          keywords: ['followup', 'ewaste', 'dropoff'],
          title: 'E-Waste – Finding Authorized Ward Drop-Off Points',
          intent: 'waste_segregation',
          suggestedAction: 'report',
          answer:
`Where and How to Drop Off Electronic Waste:

1. Finding Your Nearest Ward Drop-Off Point:
   - Visit your local Municipal Ward Office or citizen facilitation center, which houses permanent e-waste collection receptacles.
   - Authorized consumer electronics retail stores and brand service centers also provide drop boxes under Extended Producer Responsibility (EPR) programs.

2. Preparation Checklist:
   - Remove memory cards and SIM cards; perform a factory data reset on mobile devices and laptops.
   - Wrap any cracked or leaking batteries in individual plastic pouches to prevent contact with other items.

3. Heavy Appliances:
   - For bulky electronics (televisions, washing machines, refrigerators), schedule a doorstep collection through your ward's authorized recycling partner rather than transporting them yourself.`,
        };
      }

      if (activeDomain === 'plastic_recycling') {
        return {
          id: 'waste_plastic_followup',
          category: 'Recyclables Management',
          keywords: ['followup', 'recycling', 'collection'],
          title: 'Dry Recyclables – Storage & Collection Day Preparation',
          intent: 'waste_segregation',
          suggestedAction: 'report',
          answer:
`Preparation & Collection Tips for Dry Recyclables:

1. Keep Clean and Completely Dry:
   - Ensure all plastic milk pouches, oil bottles, and takeout containers are rinsed and air-dried before storing in your Blue Bin. Wet or soiled paper cannot be recycled.

2. Local Dry Waste Collection Centers (DWCC):
   - You can drop off large quantities of flattened cardboard cartons and plastic bottles directly at your ward's Dry Waste Collection Center.

3. Informal Recyclers (Kabadiwalas):
   - Handing over clean cardboard, metal tins, and pet bottles to local neighborhood scrap collectors supports the circular recycling economy and diverts tons from landfills.`,
        };
      }

      if (activeDomain === 'kitchen_compost') {
        return {
          id: 'waste_kitchen_followup',
          category: 'Wet Waste Management',
          keywords: ['followup', 'compost', 'kitchen'],
          title: 'Composting & Wet Waste – Best Home Practices',
          intent: 'waste_segregation',
          suggestedAction: 'report',
          answer:
`Practical Composting Next Steps for Household Kitchen Waste:

1. Easy 3-Pot Aerated Home Composting:
   - Use three earthen or ventilated plastic pots. Fill Pot 1 daily with chopped kitchen scraps (greens) layered with dry crushed leaves or cocopeat (browns).
   - Once full, shift to Pot 2. Within 45 to 60 days, Pot 1 yields dark, nutrient-rich organic compost with an earthy aroma.

2. Moisture & Odor Control:
   - Sprinkle a handful of dry leaves or sawdust over fresh vegetable peels every day to maintain balanced carbon-to-nitrogen ratios and eliminate foul smells.
   - Avoid adding cooked meat, dairy, or oily gravies to small home composters.`,
        };
      }

      if (activeDomain === 'water_leakage') {
        return {
          id: 'water_leakage_followup',
          category: 'Water Supply',
          keywords: ['followup', 'water', 'leak'],
          title: 'Water Leakage – Escalation & Containment Steps',
          intent: 'water_leakage',
          suggestedAction: 'report',
          answer:
`Next Steps for Municipal Water Supply Pipeline Leaks:

1. Pipeline Crew Response:
   - Municipal water supply lines operate on scheduled pressure cycles. Once a leak is logged on CiviFix, ward water board valve operators inspect line pressure to isolate the damaged valve segment.

2. Road Subgrade Safety:
   - If clean water is bubbling up through asphalt, avoid driving heavy vehicles over the area as underground soil erosion can cause unexpected sinkholes or road collapses.

3. Tracking Your Ticket:
   - Monitor the assigned ward water crew's updates in "My Reports". If water flooding endangers residential basements, add an urgent follow-up note to your report.`,
        };
      }

      if (activeDomain === 'drainage') {
        return {
          id: 'drainage_followup',
          category: 'Stormwater & Drainage',
          keywords: ['followup', 'drainage', 'flood'],
          title: 'Drainage & Flooding – Desilting Protocol',
          intent: 'drainage_flooding',
          suggestedAction: 'report',
          answer:
`Next Steps for Blocked Stormwater Drains & Flooding:

1. Desilting Truck Deployment:
   - Municipal health and engineering squads dispatch super-sucker or jetting machines to extract silt, solid plastic blockages, and debris from blocked culverts.

2. Health Precautions:
   - Keep children and pets away from stagnant floodwaters, which can contain sewage contamination and waterborne pathogens.
   - Spray citronella or use mosquito repellents around stagnant roadside puddles to curb dengue breeding.`,
        };
      }

      if (activeDomain === 'garbage_overflow') {
        return {
          id: 'garbage_overflow_followup',
          category: 'Waste Management',
          keywords: ['followup', 'garbage', 'clearance'],
          title: 'Garbage Clearance – Next Steps & Municipal Squad Dispatch',
          intent: 'garbage_overflow',
          suggestedAction: 'my_reports',
          answer:
`Next Steps for Your Reported Garbage Overflow:

1. Ward Sanitation Squad Dispatch:
   - Ward health supervisors inspect logged trash accumulations within 24 to 48 hours. A localized tipper truck or mechanized compactor is dispatched based on the reported volume.

2. Disinfection & Cleanliness:
   - After waste clearance, sanitation teams apply disinfectant lime powder over the ground to deter stray animals and eliminate foul odors.

3. Live Status Updates:
   - Open "My Reports" to track progress from "Submitted" to "Resolved" with completion notes from the ward team.`,
        };
      }

      if (activeDomain === 'report_tracking') {
        return {
          id: 'report_tracking_followup',
          category: 'CiviFix Guide',
          keywords: ['followup', 'status', 'resolution'],
          title: 'Understanding Report Status Updates & Re-Opening Tickets',
          intent: 'report_tracking',
          suggestedAction: 'my_reports',
          answer:
`Detailed Status Progression & Citizen Verification:

• Under Review: A municipal triage officer in your ward is reviewing the photo and classifying severity.
• In Progress: Field engineers or sanitation workers have been assigned to address the problem.
• Resolved: Department records show repair or cleanup completed.

Citizen Verification:
If an issue is marked "Resolved" but work was incomplete on the ground, open the ticket in "My Reports" and use the "Add Note" button to provide photos showing the ongoing condition so supervisors can re-evaluate.`,
        };
      }
    }
  }

  // Map typos to canonical tokens
  const normalizedTokens = rawTokens.map((t) => COMMON_TYPO_MAP[t] || t);
  const meaningfulTokens = normalizedTokens.filter((t) => !STOP_WORDS.has(t) && t.length > 2);

  // 2. Direct high-priority intent phrase checks
  // A. How to Report Intent
  const isReportIntent =
    cleanQuery.includes('how to report') ||
    cleanQuery.includes('how do i report') ||
    cleanQuery.includes('file a complaint') ||
    cleanQuery.includes('file complaint') ||
    cleanQuery.includes('lodge a complaint') ||
    cleanQuery.includes('lodge complaint') ||
    cleanQuery.includes('register complaint') ||
    cleanQuery.includes('submit report') ||
    cleanQuery.includes('how to file') ||
    cleanQuery.includes('log an issue') ||
    cleanQuery.includes('log issue') ||
    (meaningfulTokens.includes('complaint') && (meaningfulTokens.includes('file') || meaningfulTokens.includes('submit') || meaningfulTokens.includes('lodge') || meaningfulTokens.includes('register') || meaningfulTokens.includes('new') || meaningfulTokens.includes('how'))) ||
    (meaningfulTokens.includes('report') && (meaningfulTokens.includes('submit') || meaningfulTokens.includes('create') || meaningfulTokens.includes('new') || meaningfulTokens.includes('file') || meaningfulTokens.includes('how')));

  // B. Tracking Intent
  const isTrackingIntent =
    cleanQuery.includes('track') ||
    cleanQuery.includes('tracking') ||
    cleanQuery.includes('check status') ||
    cleanQuery.includes('track status') ||
    cleanQuery.includes('my reports') ||
    cleanQuery.includes('where is my report') ||
    cleanQuery.includes('tracking id') ||
    cleanQuery.includes('tracking number') ||
    meaningfulTokens.includes('tracking') ||
    meaningfulTokens.includes('track') ||
    (meaningfulTokens.includes('status') && (meaningfulTokens.includes('report') || meaningfulTokens.includes('complaint')));

  // Check if query specifies a concrete civic domain (pothole, water leak, drainage, streetlight, garbage)
  const domainSpecificKeywords = [
    'pothole', 'potholes', 'crater', 'craters', 'water leak', 'leakage', 'pipeline', 'water pipe',
    'drain', 'drains', 'drainage', 'gutter', 'gutters', 'sewage', 'streetlight', 'streetlights',
    'street light', 'lamp post', 'overflow', 'dumping', 'garbage dump', 'trash dump', 'e-waste',
    'electronic waste', 'waste segregation', 'segregate waste'
  ];
  const hasSpecificDomain = domainSpecificKeywords.some((dk) => cleanQuery.includes(dk));

  // Check if query is composed exclusively of vague civic words without domain specificity
  const isPurelyVagueCivic =
    meaningfulTokens.length > 0 &&
    meaningfulTokens.every((t) => VAGUE_CIVIC_WORDS.has(t)) &&
    !isReportIntent &&
    !isTrackingIntent &&
    !hasSpecificDomain;

  if (isPurelyVagueCivic) {
    const clarif = CIVIC_KNOWLEDGE_ENTRIES.find((e) => e.id === 'clarification');
    return clarif || null;
  }

  // Score each entry
  let bestEntry: CivicKnowledgeEntry | null = null;
  let highestScore = 0;

  for (const entry of CIVIC_KNOWLEDGE_ENTRIES) {
    // Skip fallback entries during normal topic matching
    if (entry.id === 'clarification' || entry.id === 'unrelated') continue;

    let score = 0;

    // Apply Intent Bonuses
    // Only give general complaint submission the bonus if no specific civic issue domain was mentioned
    if (entry.id === 'complaint_submission' && isReportIntent && !hasSpecificDomain) score += 40;
    if (entry.id === 'report_tracking' && isTrackingIntent) score += 40;

    // If report intent is present and the entry is the specific domain topic that can be reported, boost that domain
    if (isReportIntent && hasSpecificDomain && entry.id !== 'complaint_submission' && entry.suggestedAction === 'report') {
      const matchesDomain = domainSpecificKeywords.some(
        (dk) => entry.keywords.includes(dk) || (cleanQuery.includes(dk) && entry.keywords.some((k) => cleanQuery.includes(k)))
      );
      if (matchesDomain) {
        score += 35;
      }
    }

    // Multi-word phrase matching (highest precision)
    for (const kw of entry.keywords) {
      if (kw.includes(' ')) {
        if (cleanQuery.includes(kw)) {
          score += 25;
        }
      }
    }

    // Token and typo matching
    for (const token of meaningfulTokens) {
      for (const kw of entry.keywords) {
        if (kw === token) {
          // Exact token match
          score += 12;
          break;
        } else if (kw.length >= 4 && token.length >= 4) {
          // Substring / plural check
          if (token.includes(kw) || kw.includes(token)) {
            score += 7;
            break;
          }
          // Typo tolerance via Levenshtein distance
          const maxDist = token.length > 6 ? 2 : 1;
          const dist = getLevenshteinDistance(token, kw);
          if (dist <= maxDist) {
            score += 6;
            break;
          }
        }
      }
    }

    if (score > highestScore) {
      highestScore = score;
      bestEntry = entry;
    }
  }

  // If a topic scored well, return it
  if (highestScore >= 10 && bestEntry) {
    return bestEntry;
  }

  // Check if query is ambiguous civic inquiry (contains vague civic keywords)
  const hasVagueCivicWord = normalizedTokens.some((t) => VAGUE_CIVIC_WORDS.has(t));
  if (hasVagueCivicWord || rawTokens.length <= 1) {
    // Return clarification entry to guide the citizen
    const clarif = CIVIC_KNOWLEDGE_ENTRIES.find((e) => e.id === 'clarification');
    return clarif || null;
  }

  // If no civic context is found, return unrelated boundary entry
  const unrelated = CIVIC_KNOWLEDGE_ENTRIES.find((e) => e.id === 'unrelated');
  return unrelated || null;
}

import assert from 'node:assert';
import {
  searchCivicKnowledge,
  CIVIC_KNOWLEDGE_ENTRIES,
  CivicKnowledgeEntry,
} from '../src/data/civicKnowledge.js';

console.log('--- RUNNING CIVIFIX AI CIVIC KNOWLEDGE & FALLBACK TEST SUITE ---');

let passedTests = 0;
let totalTests = 0;

function test(name: string, fn: () => void) {
  totalTests++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    Error:`, err.message);
    throw err;
  }
}

// 1. BASIC CIVIC KNOWLEDGE BASE STRUCTURE & INTEGRITY
test('Knowledge base contains all required civic entries', () => {
  const ids = CIVIC_KNOWLEDGE_ENTRIES.map((e) => e.id);
  assert(ids.includes('waste_segregation'), 'Missing waste_segregation');
  assert(ids.includes('garbage_collection'), 'Missing garbage_collection');
  assert(ids.includes('garbage_overflow'), 'Missing garbage_overflow');
  assert(ids.includes('potholes_roads'), 'Missing potholes_roads');
  assert(ids.includes('water_leakage'), 'Missing water_leakage');
  assert(ids.includes('drainage_flooding'), 'Missing drainage_flooding');
  assert(ids.includes('streetlights'), 'Missing streetlights');
  assert(ids.includes('public_cleanliness'), 'Missing public_cleanliness');
  assert(ids.includes('complaint_submission'), 'Missing complaint_submission');
  assert(ids.includes('report_tracking'), 'Missing report_tracking');
  assert(ids.includes('clarification'), 'Missing clarification');
  assert(ids.includes('unrelated'), 'Missing unrelated');
});

// 2. EMPTY AND WHITESPACE INPUT TESTS
test('Empty and whitespace-only queries return null', () => {
  assert.strictEqual(searchCivicKnowledge(''), null);
  assert.strictEqual(searchCivicKnowledge('   '), null);
  assert.strictEqual(searchCivicKnowledge('\t\n'), null);
  assert.strictEqual(searchCivicKnowledge('!@#$%^&*()'), null);
});

// 3. COMMON NATURAL-LANGUAGE CIVIC QUESTIONS
test('Waste Segregation query returns Green/Blue/Red guidance', () => {
  const res = searchCivicKnowledge('How do I segregate wet and dry waste?');
  assert(res !== null, 'Should return a result');
  assert.strictEqual(res.intent, 'waste_segregation');
  assert(res.answer.includes('Green Bin'), 'Should explain Green Bin');
  assert(res.answer.includes('Blue Bin'), 'Should explain Blue Bin');
  assert(res.answer.includes('Red Bag'), 'Should explain Red Bag');
  assert.strictEqual(res.suggestedAction, 'report');
});

test('Kitchen waste and peels query matches Waste Segregation', () => {
  const res = searchCivicKnowledge('Where should I throw vegetable peels and food scraps?');
  assert(res !== null);
  assert.strictEqual(res.intent, 'waste_segregation');
  assert(res.answer.includes('kitchen waste') || res.answer.includes('vegetable peels'));
});

test('Door-to-door garbage collection timing query matches Garbage Collection', () => {
  const res = searchCivicKnowledge('When does the morning garbage collection truck arrive?');
  assert(res !== null);
  assert.strictEqual(res.intent, 'garbage_collection');
  assert(res.answer.includes('morning hours'));
  // Must verify instructions without fabricating timings
  assert(res.answer.includes('Ward Office') || res.answer.includes('RWA'));
});

test('Overflowing community bin matches Garbage Overflow with safety notice', () => {
  const res = searchCivicKnowledge('Community garbage bin is overflowing onto the street with bad stench');
  assert(res !== null);
  assert.strictEqual(res.intent, 'garbage_overflow');
  assert(res.answer.includes('+ Report'));
  assert(res.answer.includes('Never burn open trash piles'));
  assert.strictEqual(res.suggestedAction, 'report');
});

test('Pothole hazard query matches Potholes with step-by-step reporting and safety notice', () => {
  const res = searchCivicKnowledge('Deep dangerous road crater and pothole causing vehicle accidents');
  assert(res !== null);
  assert.strictEqual(res.intent, 'potholes_roads');
  assert(res.answer.includes('+ Report'));
  assert(res.answer.includes('Severity') || res.answer.includes('severity'));
  assert(res.answer.includes('pedestrian sidewalk') || res.answer.includes('footpath'));
  assert.strictEqual(res.suggestedAction, 'report');
});

test('Clean water leak query matches Water Supply with reporting steps', () => {
  const res = searchCivicKnowledge('Clean drinking water supply pipe burst and is flooding the road');
  assert(res !== null);
  assert.strictEqual(res.intent, 'water_leakage');
  assert(res.answer.includes('Water Leakage'));
  assert(res.answer.includes('valve') || res.answer.includes('pressure'));
  assert.strictEqual(res.suggestedAction, 'report');
});

test('Blocked gutter query matches Drainage and monsoon flooding', () => {
  const res = searchCivicKnowledge('Stormwater drain is blocked with silt causing monsoon waterlogging');
  assert(res !== null);
  assert.strictEqual(res.intent, 'drainage_flooding');
  assert(res.answer.includes('Drainage'));
  assert(res.answer.includes('mosquito'));
  assert.strictEqual(res.suggestedAction, 'report');
});

test('Dark street light query matches Streetlights with pole number guidance', () => {
  const res = searchCivicKnowledge('The street light pole near my house is dark and flickering');
  assert(res !== null);
  assert.strictEqual(res.intent, 'streetlights');
  assert(res.answer.includes('Broken Streetlight'));
  assert(res.answer.includes('Pole Number') || res.answer.includes('pole number'));
  assert.strictEqual(res.suggestedAction, 'report');
});

test('Public cleanliness and anti-spitting query matches Public Cleanliness', () => {
  const res = searchCivicKnowledge('What are the rules on public spitting and cleanliness in our neighborhood?');
  assert(res !== null);
  assert.strictEqual(res.intent, 'public_cleanliness');
  assert(res.answer.includes('Spitting') || res.answer.includes('spitting'));
  assert(res.answer.includes('cloth') || res.answer.includes('plastics'));
});

// 4. COMPLAINT SUBMISSION AND TRACKING INTENTS
test('How to file complaint directs citizen to + Report screen without fake report creation', () => {
  const res = searchCivicKnowledge('How do I file a new complaint in CiviFix?');
  assert(res !== null);
  assert.strictEqual(res.intent, 'complaint_submission');
  assert(res.answer.includes('+ Report'));
  assert(res.answer.includes('does not automatically file complaints'));
  assert.strictEqual(res.suggestedAction, 'report');
});

test('How to track reports directs citizen to My Reports screen without fake status dates', () => {
  const res = searchCivicKnowledge('How can I track my submitted report status?');
  assert(res !== null);
  assert.strictEqual(res.intent, 'report_tracking');
  assert(res.answer.includes('My Reports'));
  assert(res.answer.includes('Submitted'));
  assert(res.answer.includes('In Progress'));
  assert(res.answer.includes('Resolved'));
  // Never invent fake phone numbers or deadlines
  assert(res.answer.includes('Cloud Firestore') || res.answer.includes('timeline'));
  assert.strictEqual(res.suggestedAction, 'my_reports');
});

// 5. TYPO AND SPELLING MISTAKE TOLERANCE
test('Handles common spelling mistakes and typos across domains', () => {
  // Pothole typo
  const r1 = searchCivicKnowledge('pothol in the roadd');
  assert(r1 !== null);
  assert.strictEqual(r1.intent, 'potholes_roads');

  // Garbage typo
  const r2 = searchCivicKnowledge('garbeg overflow');
  assert(r2 !== null);
  assert.strictEqual(r2.intent, 'garbage_overflow');

  // Segregation typo
  const r3 = searchCivicKnowledge('segragate wet and dry waste');
  assert(r3 !== null);
  assert.strictEqual(r3.intent, 'waste_segregation');

  // Streetlight typo
  const r4 = searchCivicKnowledge('stretlight is not working at night');
  assert(r4 !== null);
  assert.strictEqual(r4.intent, 'streetlights');

  // Water leak typo
  const r5 = searchCivicKnowledge('watr leek in pipline');
  assert(r5 !== null);
  assert.strictEqual(r5.intent, 'water_leakage');

  // Drainage typo
  const r6 = searchCivicKnowledge('drane is clogged with mud');
  assert(r6 !== null);
  assert.strictEqual(r6.intent, 'drainage_flooding');

  // Tracking typo
  const r7 = searchCivicKnowledge('trake my complint');
  assert(r7 !== null);
  assert(r7.intent === 'report_tracking' || r7.intent === 'complaint_submission');
});

// 6. AMBIGUOUS & UNCLEAR QUERIES (CLARIFICATION TRIGGER)
test('Vague civic inquiries return helpful clarification question with options', () => {
  const vagueQueries = ['help', 'issue', 'there is a problem', 'something is broken on my road', 'assist me'];
  for (const q of vagueQueries) {
    const res = searchCivicKnowledge(q);
    assert(res !== null, `Failed on query: "${q}"`);
    assert.strictEqual(res.intent, 'clarification', `Expected clarification for "${q}" but got ${res.intent}`);
    assert(res.answer.includes('Could you please specify which civic topic you need help with?'));
    assert(res.answer.includes('1. Waste Segregation'));
    assert(res.answer.includes('3. Potholes'));
    assert(res.answer.includes('5. Blocked Drains'));
  }
});

// 7. UNRELATED NON-CIVIC QUESTIONS (OUT-OF-SCOPE BOUNDARY)
test('Unrelated non-civic questions return friendly scope boundary', () => {
  const unrelatedQueries = [
    'write me a python function to sort an array',
    'who was the first president of the United States',
    'what is the recipe for chocolate chip cookies',
  ];
  for (const q of unrelatedQueries) {
    const res = searchCivicKnowledge(q);
    assert(res !== null, `Failed on query: "${q}"`);
    assert.strictEqual(res.intent, 'unrelated', `Expected unrelated for "${q}" but got ${res.intent}`);
    assert(res.answer.includes('I am the CiviFix Civic Assistant, specifically designed to help citizens'));
    assert(res.answer.includes('unable to answer'));
  }
});

// 8. SIMULATED API FAILURE FALLBACK WORKFLOW
test('Simulated API failure fallback provides complete, actionable civic response', () => {
  // Simulates when fetch('/api/gemini/chat') catches an error or server fallback triggers
  const userMessage = 'Water is leaking from an underground pipe in front of our building';
  const fallback = searchCivicKnowledge(userMessage);

  assert(fallback !== null);
  assert.strictEqual(fallback.intent, 'water_leakage');

  const simulatedServerResponse = {
    reply: fallback.answer,
    isFallback: true,
    fallbackTopic: fallback.title,
    intent: fallback.intent,
    suggestedAction: fallback.suggestedAction,
  };

  assert.strictEqual(simulatedServerResponse.isFallback, true);
  assert.strictEqual(simulatedServerResponse.fallbackTopic, 'Reporting Water Supply Pipeline Leaks');
  assert.strictEqual(simulatedServerResponse.suggestedAction, 'report');
  assert(simulatedServerResponse.reply.includes('Tap "+ Report"'));
});

// 9. PHASE 7 CHATBOT REPETITION BUG VERIFICATION SUITE
test('Scenario 1: Ask "How do I report a pothole?" returns dedicated pothole guidance', () => {
  const res = searchCivicKnowledge('How do I report a pothole?');
  assert(res !== null);
  assert.strictEqual(res.intent, 'potholes_roads');
  assert(res.title.includes('Potholes'));
  assert(res.answer.includes('Pothole'));
  assert(res.answer.includes('+ Report'));
  assert(res.answer.includes('severity') || res.answer.includes('Severity'));
  assert.strictEqual(res.suggestedAction, 'report');
});

test('Scenario 2: Ask "How can I track my report?" returns tracking guide', () => {
  const res = searchCivicKnowledge('How can I track my report?');
  assert(res !== null);
  assert.strictEqual(res.intent, 'report_tracking');
  assert(res.title.includes('Track'));
  assert(res.answer.includes('My Reports'));
  assert(res.answer.includes('Submitted'));
  assert(res.answer.includes('Resolved'));
  assert.strictEqual(res.suggestedAction, 'my_reports');
});

test('Scenario 3: Ask "What is waste segregation?" returns 2-Bin 1-Bag overview', () => {
  const res = searchCivicKnowledge('What is waste segregation?');
  assert(res !== null);
  assert.strictEqual(res.intent, 'waste_segregation');
  assert(res.answer.includes('Green Bin'));
  assert(res.answer.includes('Blue Bin'));
  assert(res.answer.includes('Red Bag'));
});

test('Scenario 4: Ask "How can I dispose of electronic waste?" returns dedicated E-Waste guidance', () => {
  const res = searchCivicKnowledge('How can I dispose of electronic waste?');
  assert(res !== null);
  assert.strictEqual(res.id, 'waste_ewaste');
  assert(res.title.includes('Electronic Waste') || res.title.includes('E-Waste'));
  assert(res.answer.includes('heavy metals') || res.answer.includes('lead'));
  assert(res.answer.includes('e-drop') || res.answer.includes('collection'));
  // Must NOT be the generic 2-Bin article
  assert(!res.answer.includes('• Green Bin (Wet Waste):'));
});

test('Scenario 5: Ask follow-up question referring to previous pothole conversation returns contextual next steps', () => {
  const history = [
    { sender: 'user', text: 'How do I report a pothole?' },
    { sender: 'assistant', text: 'To log a road hazard or pothole for municipal asphalt repair: Tap "+ Report"...' },
  ];
  const followUp = searchCivicKnowledge('What should I do next?', history);
  assert(followUp !== null);
  assert.strictEqual(followUp.id, 'potholes_roads_followup');
  assert(followUp.title.includes('Pothole') && followUp.title.includes('Next Steps'));
  assert(followUp.answer.includes('48 to 72 hours'));
  assert(followUp.answer.includes('My Reports'));
});

test('Scenario 5b: Ask follow-up question referring to previous e-waste conversation returns drop-off steps', () => {
  const history = [
    { sender: 'user', text: 'How can I dispose of electronic waste?' },
    { sender: 'assistant', text: 'Electronic Waste (E-Waste) Safe Disposal Guidelines: Deposit electronics at designated municipal ward kiosks...' },
  ];
  const followUp = searchCivicKnowledge('Where do I take them?', history);
  assert(followUp !== null);
  assert.strictEqual(followUp.id, 'waste_ewaste_followup');
  assert(followUp.answer.includes('Ward Office'));
  assert(followUp.answer.includes('factory data reset'));
});

test('Scenario 6: Ask an unrelated question returns polite Scope of Service boundary', () => {
  const res = searchCivicKnowledge('What is the capital of Australia?');
  assert(res !== null);
  assert.strictEqual(res.id, 'unrelated');
  assert.strictEqual(res.intent, 'unrelated');
  assert(res.answer.includes('CiviFix Civic Assistant'));
  assert(res.answer.includes('unable to answer'));
});

test('Scenario 7 & 8: Verify answers across diverse queries are distinct and non-repetitive', () => {
  const queries = [
    'How do I report a pothole?',
    'How can I track my report?',
    'What is waste segregation?',
    'How can I dispose of electronic waste?',
    'What is the capital of Australia?',
  ];

  const results = queries.map((q) => searchCivicKnowledge(q));
  const distinctTitles = new Set(results.map((r) => r?.title));
  const distinctAnswers = new Set(results.map((r) => r?.answer));

  // Ensure every single question got a distinct, unique response!
  assert.strictEqual(distinctTitles.size, queries.length, 'Every distinct query must receive a distinct title');
  assert.strictEqual(distinctAnswers.size, queries.length, 'Every distinct query must receive a distinct answer');
});

// 10. MULTI-TURN CONVERSATIONS A, B, C, D, E SUITE
test('Conversation A: Pothole multi-turn flow (report -> submit -> timeline -> escalation)', () => {
  // Turn 1: User asks about pothole on road
  const t1 = searchCivicKnowledge('There is a big hole on my road. What should I do?');
  assert(t1 !== null);
  assert.strictEqual(t1.intent, 'potholes_roads');
  assert(t1.answer.includes('+ Report'));

  const historyT1 = [
    { sender: 'user', text: 'There is a big hole on my road. What should I do?' },
    { sender: 'assistant', text: t1.answer },
  ];

  // Turn 2: User asks how to complain about this
  const t2 = searchCivicKnowledge('How can I complain about this?', historyT1);
  assert(t2 !== null);
  assert.strictEqual(t2.intent, 'potholes_roads');
  assert(t2.answer.includes('+ Report'));

  const historyT2 = [
    ...historyT1,
    { sender: 'user', text: 'How can I complain about this?' },
    { sender: 'assistant', text: t2.answer },
  ];

  // Turn 3: User asks what happens after submission
  const t3 = searchCivicKnowledge('What happens after I submit it?', historyT2);
  assert(t3 !== null);
  assert(t3.answer.includes('Municipal Inspection Timeline') || t3.answer.includes('48 to 72 hours'));
  assert(t3.answer.includes('My Reports'));

  const historyT3 = [
    ...historyT2,
    { sender: 'user', text: 'What happens after I submit it?' },
    { sender: 'assistant', text: t3.answer },
  ];

  // Turn 4: User asks how long will it take
  const t4 = searchCivicKnowledge('How long will it take?', historyT3);
  assert(t4 !== null);
  assert(t4.answer.includes('24 to 72 Hours') || t4.answer.includes('48 to 72 hours'));

  const historyT4 = [
    ...historyT3,
    { sender: 'user', text: 'How long will it take?' },
    { sender: 'assistant', text: t4.answer },
  ];

  // Turn 5: User asks what if nobody fixes it
  const t5 = searchCivicKnowledge('What if nobody fixes it?', historyT4);
  assert(t5 !== null);
  assert(t5.title.includes('Escalation') || t5.id === 'complaint_escalation');
  assert(t5.answer.includes('Add Note'));
});

test('Conversation B: E-Waste multi-turn flow (drop off -> checklist -> battery)', () => {
  // Turn 1: Where can I take my old phone?
  const t1 = searchCivicKnowledge('Where can I take my old phone?');
  assert(t1 !== null);
  assert(t1.id.includes('waste_ewaste'));

  const historyT1 = [
    { sender: 'user', text: 'Where can I take my old phone?' },
    { sender: 'assistant', text: t1.answer },
  ];

  // Turn 2: What should I do before handing it over?
  const t2 = searchCivicKnowledge('What should I do before handing it over?', historyT1);
  assert(t2 !== null);
  assert(t2.id === 'waste_ewaste_checklist');
  assert(t2.answer.includes('Data Backup') || t2.answer.includes('Factory Reset'));
  assert(t2.answer.includes('SIM card'));

  const historyT2 = [
    ...historyT1,
    { sender: 'user', text: 'What should I do before handing it over?' },
    { sender: 'assistant', text: t2.answer },
  ];

  // Turn 3: What about its battery?
  const t3 = searchCivicKnowledge('What about its battery?', historyT2);
  assert(t3 !== null);
  assert.strictEqual(t3.id, 'waste_batteries');
  assert(t3.answer.includes('lithium') || t3.answer.includes('Battery'));
  assert(t3.answer.includes('Never throw'));
});

test('Conversation C: Waste Segregation multi-turn flow (overview -> blue bin -> food waste -> composting)', () => {
  // Turn 1: How do I segregate waste?
  const t1 = searchCivicKnowledge('How do I segregate waste?');
  assert(t1 !== null);
  assert.strictEqual(t1.intent, 'waste_segregation');

  const historyT1 = [
    { sender: 'user', text: 'How do I segregate waste?' },
    { sender: 'assistant', text: t1.answer },
  ];

  // Turn 2: What goes into the blue bin?
  const t2 = searchCivicKnowledge('What goes into the blue bin?', historyT1);
  assert(t2 !== null);
  assert.strictEqual(t2.id, 'waste_plastic_recycling');
  assert(t2.answer.includes('Blue Bin'));

  const historyT2 = [
    ...historyT1,
    { sender: 'user', text: 'What goes into the blue bin?' },
    { sender: 'assistant', text: t2.answer },
  ];

  // Turn 3: Can I put food waste there?
  const t3 = searchCivicKnowledge('Can I put food waste there?', historyT2);
  assert(t3 !== null);
  assert(t3.id === 'waste_blue_bin_no_food');
  assert(t3.answer.includes('NEVER'));
  assert(t3.answer.includes('Contamination'));
  assert(t3.answer.includes('Green Bin'));

  const historyT3 = [
    ...historyT2,
    { sender: 'user', text: 'Can I put food waste there?' },
    { sender: 'assistant', text: t3.answer },
  ];

  // Turn 4: Can I compost it at home?
  const t4 = searchCivicKnowledge('Can I compost it at home?', historyT3);
  assert(t4 !== null);
  assert.strictEqual(t4.id, 'waste_home_composting');
  assert(t4.answer.includes('Composting Guide') || t4.answer.includes('compost'));
});

test('Conversation D: Water Leakage multi-turn flow (leak report -> details -> after submit -> track)', () => {
  // Turn 1: Water is leaking from an underground pipe
  const t1 = searchCivicKnowledge('Water is leaking from an underground pipe.');
  assert(t1 !== null);
  assert.strictEqual(t1.intent, 'water_leakage');

  const historyT1 = [
    { sender: 'user', text: 'Water is leaking from an underground pipe.' },
    { sender: 'assistant', text: t1.answer },
  ];

  // Turn 2: What info should I provide?
  const t2 = searchCivicKnowledge('What info should I provide?', historyT1);
  assert(t2 !== null);
  assert(t2.id === 'water_leak_info_checklist');
  assert(t2.answer.includes('Exact Location') || t2.answer.includes('Landmark'));
  assert(t2.answer.includes('Photo'));

  const historyT2 = [
    ...historyT1,
    { sender: 'user', text: 'What info should I provide?' },
    { sender: 'assistant', text: t2.answer },
  ];

  // Turn 3: What happens after submission?
  const t3 = searchCivicKnowledge('What happens after submission?', historyT2);
  assert(t3 !== null);
  assert(t3.answer.includes('Pipeline Crew Response') || t3.answer.includes('valve operators'));

  const historyT3 = [
    ...historyT2,
    { sender: 'user', text: 'What happens after submission?' },
    { sender: 'assistant', text: t3.answer },
  ];

  // Turn 4: How do I check repair status?
  const t4 = searchCivicKnowledge('How do I check repair status?', historyT3);
  assert(t4 !== null);
  assert.strictEqual(t4.id, 'report_tracking');
  assert(t4.answer.includes('My Reports'));
});

test('Conversation E: Garbage Overflow multi-turn flow (pile report -> how to report -> photo -> next steps)', () => {
  // Turn 1: Garbage is piling up near my house
  const t1 = searchCivicKnowledge('Garbage is piling up near my house.');
  assert(t1 !== null);
  assert.strictEqual(t1.intent, 'garbage_overflow');

  const historyT1 = [
    { sender: 'user', text: 'Garbage is piling up near my house.' },
    { sender: 'assistant', text: t1.answer },
  ];

  // Turn 2: How can I report it?
  const t2 = searchCivicKnowledge('How can I report it?', historyT1);
  assert(t2 !== null);
  assert.strictEqual(t2.intent, 'garbage_overflow');

  const historyT2 = [
    ...historyT1,
    { sender: 'user', text: 'How can I report it?' },
    { sender: 'assistant', text: t2.answer },
  ];

  // Turn 3: What photo should I take?
  const t3 = searchCivicKnowledge('What photo should I take?', historyT2);
  assert(t3 !== null);
  assert(t3.id === 'garbage_photo_guide' || t3.id === 'road_safety');
  assert(t3.answer.includes('Wide-Angle') || t3.answer.includes('Perspective') || t3.answer.includes('photo'));

  const historyT3 = [
    ...historyT2,
    { sender: 'user', text: 'What photo should I take?' },
    { sender: 'assistant', text: t3.answer },
  ];

  // Turn 4: What happens next?
  const t4 = searchCivicKnowledge('What happens next?', historyT3);
  assert(t4 !== null);
  assert(t4.answer.includes('Sanitation Squad') || t4.answer.includes('tipper truck') || t4.answer.includes('My Reports'));
});

// 11. STANDALONE NATURAL-LANGUAGE QUERIES
test('Standalone query: "There is a big hole on my road. What should I do?"', () => {
  const res = searchCivicKnowledge('There is a big hole on my road. What should I do?');
  assert(res !== null);
  assert.strictEqual(res.intent, 'potholes_roads');
  assert(res.answer.includes('+ Report'));
});

test('Standalone query: "What photo should I upload?"', () => {
  const res = searchCivicKnowledge('What photo should I upload?');
  assert(res !== null);
  assert(res.answer.includes('Photo') || res.answer.includes('photo'));
  assert(res.answer.includes('footpath') || res.answer.includes('sidewalk') || res.answer.includes('landmark'));
});

test('Standalone query: "Is this recyclable?"', () => {
  const res = searchCivicKnowledge('Is this recyclable?');
  assert(res !== null);
  assert.strictEqual(res.id, 'waste_plastic_recycling');
  assert(res.answer.includes('Blue Bin'));
});

test('Standalone query: "How long will it take?"', () => {
  const res = searchCivicKnowledge('How long will it take?');
  assert(res !== null);
  assert.strictEqual(res.id, 'report_status_stages');
  assert(res.answer.includes('Under Review') || res.answer.includes('In Progress'));
});

console.log(`\nAll ${passedTests} / ${totalTests} test cases passed successfully!`);

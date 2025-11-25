const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Environment variables
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const MODEL_NAME = process.env.MODEL_NAME || 'gpt-4o-mini';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Database schema context for LLM
const DATABASE_SCHEMA = `
DATABASE SCHEMA:
Table: video_ad_performance

Available Columns:
- report_month (date) - Format: YYYY-MM-DD, Current data: 2025-10-01
- platform (text) - Valid values: TikTok, Instagram, Facebook, YouTube, Snapchat
- region (text) - Valid values: Northeast, Midwest, South, West
- age_group (text) - Valid values: 18-24, 25-34, 35-44, 45-54, 55-64, 65+
- gender (text) - Valid values: male, female, unknown
- spend (numeric) - Ad spend in dollars
- impressions (bigint) - Number of impressions
- video_starts (bigint) - Number of video starts
- views_3s (bigint) - Views at 3 seconds
- views_25 (bigint) - Views at 25% completion
- views_50 (bigint) - Views at 50% completion
- views_100 (bigint) - Views at 100% completion
- clicks (bigint) - Number of clicks
- conversions (bigint) - Number of conversions
- revenue (numeric) - Revenue generated in dollars

Common Calculated Metrics (use these formulas in SQL):
- ROAS = SUM(revenue) / NULLIF(SUM(spend), 0)
- CTR = (SUM(clicks)::numeric / NULLIF(SUM(impressions), 0)) * 100
- CPA = SUM(spend) / NULLIF(SUM(conversions), 0)
- Conversion Rate = (SUM(conversions)::numeric / NULLIF(SUM(clicks), 0)) * 100
- Video Completion Rate = (SUM(views_100)::numeric / NULLIF(SUM(video_starts), 0)) * 100
- CPM = (SUM(spend) / NULLIF(SUM(impressions), 0)) * 1000

Important SQL Guidelines:
1. Always use NULLIF to avoid division by zero
2. Cast to ::numeric for percentage calculations
3. Use SUM() for aggregations before calculating ratios
4. Always include report_month = '2025-10-01' in WHERE clause
5. Use GROUP BY for dimensional breakdowns
6. Use ORDER BY to sort results meaningfully
7. Limit results to reasonable numbers (LIMIT 20 for safety)
8. Do NOT include semicolons at the end of queries
`;

// Call OpenAI
async function callLLM(systemPrompt, userPrompt, maxTokens = 1000) {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: maxTokens
      })
    });
    
    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error.message);
    }
    
    return data.choices[0].message.content.trim();
    
  } catch (error) {
    console.error('OpenAI API Error:', error);
    throw error;
  }
}

// Agent 1: Query Generator Agent
async function queryGeneratorAgent(userQuestion, customPrompt) {
  console.log('QueryGeneratorAgent: Converting question to SQL');
  
  const systemPrompt = customPrompt || `You are an expert SQL query generator. Convert natural language questions into PostgreSQL queries for the video_ad_performance table.

  STEP 1: First, identify the user's business goal from their question:
  
  AWARENESS GOAL - Keywords: awareness, reach, visibility, impressions, brand, exposure, eyeballs, CPM
  CONVERSION GOAL - Keywords: sales, revenue, ROAS, conversions, ROI, profit, CPA, purchase, invest, budget
  ENGAGEMENT GOAL - Keywords: clicks, CTR, traffic, visitors, engagement, interaction, video completion, watch, "maintain traffic", "increase traffic", "website traffic", "drive traffic"
  
  If no clear goal is detected, assume CONVERSION.

  FOLLOW-UP DETECTION:
If the question contains these follow-up indicators AND no explicit new goal keyword, maintain the goal from the previous query:
- Pronouns: "there", "it", "that", "those"  
- References: "the best one", "the top performer", "the highest", "the lowest"
- Continuations: "which one", "what about the other"
- Comparisons: "both", "all of them", "the same"

Check for "Previous query goal:" in the conversation context to identify the previous goal.

Examples:
- Previous goal: AWARENESS, Question: "How much for the best one?" → Maintain AWARENESS
- Previous goal: ENGAGEMENT, Question: "Should I invest there?" → Maintain ENGAGEMENT
- Previous goal: AWARENESS, Question: "What's the ROAS?" → Switch to CONVERSION (explicit metric)
  
  STEP 2: Generate the SQL query using this schema:
  
  ${DATABASE_SCHEMA}
  
  Rules:
  - Only SELECT queries allowed
  - Always include WHERE report_month = '2025-10-01'
  - Use proper aggregations with GROUP BY when needed
  - Include ORDER BY for meaningful results
  - LIMIT results appropriately
  - NO semicolons at the end`;

  const userPrompt = `Convert this question to SQL: "${userQuestion}"

Return your response in this format:
GOAL: [AWARENESS/CONVERSION/ENGAGEMENT]
SQL: [your SQL query here]

If the question cannot be answered with the available data, explain what data is available instead of generating SQL.`;

  try {
  const response = await callLLM(systemPrompt, userPrompt, 500);
  console.log('Raw LLM Response:', response);
  
  const content = response.trim();
  
  // Parse the response to extract goal and SQL
  let goal = 'CONVERSION'; // default
  let sql = content; // fallback to full content

  // Check if response contains GOAL: format
  if (content.includes('GOAL:') && content.includes('SQL:')) {
    const lines = content.split('\n');
    const goalLine = lines.find(line => line.startsWith('GOAL:'));
    const sqlStart = content.indexOf('SQL:');
    
    if (goalLine) {
      goal = goalLine.replace('GOAL:', '').trim();
    }
    if (sqlStart !== -1) {
      sql = content.substring(sqlStart + 4).trim();
    }
  }

  // Check if it's SQL or conversational
  const isSQL = sql.toUpperCase().includes('SELECT');
  
  return {
    isSQL,
    content: sql,  // Return just the SQL part
    goal: goal     // Add the goal to the return
  };
    
  } catch (error) {
    console.error('Query Generator Agent Error:', error);
    throw error;
  }
}

// SQL Validation Layer
function validateSQL(sql) {
  console.log('Validating SQL:', sql);
  
  const upperSQL = sql.toUpperCase();
  
  // Must be SELECT only
  if (!upperSQL.startsWith('SELECT')) {
    return { valid: false, error: 'Only SELECT queries are allowed' };
  }
  
  // Check for dangerous keywords
  const dangerousKeywords = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'CREATE', 'EXEC', 'EXECUTE', 'TRUNCATE', 'GRANT', 'REVOKE'];
  for (const keyword of dangerousKeywords) {
    if (upperSQL.includes(keyword)) {
      return { valid: false, error: `Dangerous keyword detected: ${keyword}` };
    }
  }
  
  // Check for multiple semicolons (prevents chained queries)
  const semicolonCount = (sql.match(/;/g) || []).length;
  if (semicolonCount > 1) {
    return { valid: false, error: 'Multiple queries not allowed' };
  }
  
  // Must reference the correct table
  if (!upperSQL.includes('VIDEO_AD_PERFORMANCE')) {
    return { valid: false, error: 'Invalid table reference' };
  }
  
  return { valid: true };
}

// Detect requested metrics from SQL and user question
function detectRequestedMetrics(sql, userQuestion, goal) {
  // Goal-based metric detection takes priority
  if (goal === 'AWARENESS') {
    return ['impressions', 'cpm'];
  } else if (goal === 'ENGAGEMENT') {
    return ['ctr'];
  } else if (goal === 'CONVERSION') {
    return ['financial'];
  }

  const upperSQL = sql.toUpperCase();
  const lowerQuestion = userQuestion.toLowerCase();
  
  // Video metrics
  if (upperSQL.includes('VIDEO_COMPLETION_RATE') || 
      lowerQuestion.includes('video completion') || 
      lowerQuestion.includes('completion rate')) {
    return ['video_completion_rate'];
  }
  
  if (lowerQuestion.includes('video') && 
      (lowerQuestion.includes('funnel') || lowerQuestion.includes('drop') || lowerQuestion.includes('retention'))) {
    return ['video_funnel'];
  }
  
  if (lowerQuestion.includes('3-second') || lowerQuestion.includes('3 second') || 
      upperSQL.includes('VIEWS_3S')) {
    return ['video_retention'];
  }
  
  // Engagement metrics
  if (upperSQL.includes('CTR') || lowerQuestion.includes('ctr') || 
      lowerQuestion.includes('click-through') || lowerQuestion.includes('click through')) {
    return ['ctr'];
  }
  
  if (upperSQL.includes('CONVERSION_RATE') || 
      (lowerQuestion.includes('conversion') && lowerQuestion.includes('rate'))) {
    return ['conversion_rate'];
  }
  
  // Cost metrics
  if (upperSQL.includes('CPA') || lowerQuestion.includes('cost per acquisition') || 
      lowerQuestion.includes('cpa') || lowerQuestion.includes('cost per conversion') ||
      lowerQuestion.includes('acquisition cost')) {
    return ['cpa'];
  }
  
  if (upperSQL.includes('CPM') || lowerQuestion.includes('cpm') || 
      lowerQuestion.includes('cost per thousand') || lowerQuestion.includes('cost per mille')) {
    return ['cpm'];
  }
  
  // Volume metrics
  if (lowerQuestion.includes('conversion') && !lowerQuestion.includes('rate')) {
    return ['conversions'];
  }
  
  if (lowerQuestion.includes('click') && !lowerQuestion.includes('through') && !lowerQuestion.includes('rate')) {
    return ['clicks'];
  }
  
  if (lowerQuestion.includes('impression')) {
    return ['impressions'];
  }
  
  // Financial metrics
  if (lowerQuestion.includes('spend') && !lowerQuestion.includes('revenue')) {
    return ['spend'];
  }
  
  if (lowerQuestion.includes('revenue') && !lowerQuestion.includes('spend')) {
    return ['revenue'];
  }
  
  if (upperSQL.includes('ROAS') || lowerQuestion.includes('roas') || 
      lowerQuestion.includes('return on ad')) {
    return ['roas'];
  }
  
  // Strategy/Investment questions
  if (lowerQuestion.includes('invest') || lowerQuestion.includes('budget') || 
      lowerQuestion.includes('allocate') || lowerQuestion.includes('optimize')) {
    return ['financial'];
  }
  
  // Performance questions (general)
  if (lowerQuestion.includes('performance') || lowerQuestion.includes('compare') || 
      lowerQuestion.includes('best') || lowerQuestion.includes('top')) {
    // Check what aspect of performance
    if (lowerQuestion.includes('video')) {
      return ['video_completion_rate'];
    } else {
      return ['financial'];
    }
  }
  
  // Default to financial metrics for general questions
  return ['financial'];
}

// Detect visualization type and dimension from SQL
function detectVisualization(sql) {
  const upperSQL = sql.toUpperCase();
  
  // Check if it has GROUP BY (comparative query)
  if (upperSQL.includes('GROUP BY')) {
    let dimension = null;
    
    if (upperSQL.includes('GROUP BY PLATFORM')) {
      dimension = 'platform';
    } else if (upperSQL.includes('GROUP BY REGION')) {
      dimension = 'region';
    } else if (upperSQL.includes('GROUP BY AGE_GROUP')) {
      dimension = 'age_group';
    } else if (upperSQL.includes('GROUP BY GENDER')) {
      dimension = 'gender';
    }
    
    return {
      type: 'comparison',
      dimension: dimension
    };
  }
  
  // No GROUP BY means single specific query
  return {
    type: 'single',
    dimension: null
  };
}

// Helper: Parse filter values from SQL
function parseFilterValues(sql, columnName) {
  // Try single value: column = 'value'
  const singlePattern = new RegExp(`${columnName}\\s*=\\s*'([^']+)'`, 'i');
  const singleMatch = sql.match(singlePattern);
  
  if (singleMatch) {
    return [singleMatch[1]];
  }
  
  // Try IN clause: column IN ('value1', 'value2')
  const inPattern = new RegExp(`${columnName}\\s+IN\\s*\\(([^)]+)\\)`, 'i');
  const inMatch = sql.match(inPattern);
  
  if (inMatch) {
    // Extract values from IN clause
    const values = inMatch[1]
      .split(',')
      .map(v => v.trim().replace(/'/g, ''))
      .filter(v => v.length > 0);
    return values;
  }
  
  return null;
}

// Detect if query is asking for strategy/recommendations
function isStrategyQuery(userQuestion) {
  const strategyKeywords = [
    'invest', 'budget', 'allocate', 'reallocate', 'shift', 'optimize',
    'improve', 'maximize', 'should i', 'what should', 'how can i',
    'recommend', 'suggestion', 'advice', 'strategy', 'best way'
  ];
  
  const lowerQuestion = userQuestion.toLowerCase();
  return strategyKeywords.some(keyword => lowerQuestion.includes(keyword));
}

// Execute SQL and aggregate data
async function executeAndAggregate(sql, userQuestion, goal) {
  console.log('Executing SQL...');
  
  try {
    // Fetch all data from Supabase
    const { data, error } = await supabase
      .from('video_ad_performance')
      .select('*')
      .eq('report_month', '2025-10-01');
    
    if (error) throw error;
    
    // Apply WHERE filters using improved parsing
    let filteredData = data;
    
    // Platform filter
    const platformValues = parseFilterValues(sql, 'platform');
    if (platformValues) {
      filteredData = filteredData.filter(row => platformValues.includes(row.platform));
    }
    
    // Region filter
    const regionValues = parseFilterValues(sql, 'region');
    if (regionValues) {
      filteredData = filteredData.filter(row => regionValues.includes(row.region));
    }
    
    // Age group filter
    const ageValues = parseFilterValues(sql, 'age_group');
    if (ageValues) {
      filteredData = filteredData.filter(row => ageValues.includes(row.age_group));
    }
    
    // Gender filter
    const genderValues = parseFilterValues(sql, 'gender');
    if (genderValues) {
      filteredData = filteredData.filter(row => genderValues.includes(row.gender));
    }
    
    console.log(`Filtered data: ${filteredData.length} rows from ${data.length} total`);
    
    // Detect visualization type
    const visualization = detectVisualization(sql);
    
    // FIX: If single query (no GROUP BY), return null for visualization
    if (visualization.type === 'single') {
      const singleResult = aggregateSingleResult(filteredData);
      return {
        visualization: null,  // FIX: No charts for single queries
        rawData: singleResult
      };
    }
    
    // If comparison query (has GROUP BY), aggregate by dimension
    const aggregated = aggregateByDimension(filteredData, visualization.dimension);
    
    // Detect requested metrics
    const requestedMetrics = detectRequestedMetrics(sql, userQuestion, queryResult.goal);
    
    return {
      visualization: {
        type: 'comparison',
        dimension: visualization.dimension,
        requestedMetrics: requestedMetrics,  // NEW: Pass requested metrics
        goal: goal,  // ADD THIS LINE
        data: aggregated
      },
      rawData: aggregated
    };
    
  } catch (error) {
    console.error('SQL Execution Error:', error);
    throw error;
  }
}

// Helper: Aggregate single result (no grouping)
function aggregateSingleResult(data) {
  const result = {
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    revenue: 0,
    video_starts: 0,
    views_3s: 0,
    views_25: 0,
    views_50: 0,
    views_100: 0
  };
  
  data.forEach(row => {
    result.spend += parseFloat(row.spend || 0);
    result.impressions += parseInt(row.impressions || 0);
    result.clicks += parseInt(row.clicks || 0);
    result.conversions += parseInt(row.conversions || 0);
    result.revenue += parseFloat(row.revenue || 0);
    result.video_starts += parseInt(row.video_starts || 0);
    result.views_3s += parseInt(row.views_3s || 0);
    result.views_25 += parseInt(row.views_25 || 0);
    result.views_50 += parseInt(row.views_50 || 0);
    result.views_100 += parseInt(row.views_100 || 0);
  });
  
  // Calculate metrics
  result.roas = result.spend > 0 ? Math.round(result.revenue / result.spend) : 0;
  result.ctr = result.impressions > 0 ? parseFloat(((result.clicks / result.impressions) * 100).toFixed(2)) : 0;
  result.cpa = result.conversions > 0 ? parseFloat((result.spend / result.conversions).toFixed(2)) : 0;
  result.conversionRate = result.clicks > 0 ? parseFloat(((result.conversions / result.clicks) * 100).toFixed(2)) : 0;
  result.completionRate = result.video_starts > 0 ? parseFloat(((result.views_100 / result.video_starts) * 100).toFixed(2)) : 0;
  result.video_completion_rate = result.video_starts > 0 ? parseFloat(((result.views_100 / result.video_starts) * 100).toFixed(2)) : 0;
  result.cpm = result.impressions > 0 ? parseFloat(((result.spend / result.impressions) * 1000).toFixed(2)) : 0;
  
  return result;
}

// Helper: Aggregate by dimension
function aggregateByDimension(data, dimension) {
  const aggregated = {};
  
  data.forEach(row => {
    const key = row[dimension];
    
    if (!aggregated[key]) {
      aggregated[key] = {
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        revenue: 0,
        video_starts: 0,
        views_3s: 0,
        views_25: 0,
        views_50: 0,
        views_100: 0
      };
    }
    
    aggregated[key].spend += parseFloat(row.spend || 0);
    aggregated[key].impressions += parseInt(row.impressions || 0);
    aggregated[key].clicks += parseInt(row.clicks || 0);
    aggregated[key].conversions += parseInt(row.conversions || 0);
    aggregated[key].revenue += parseFloat(row.revenue || 0);
    aggregated[key].video_starts += parseInt(row.video_starts || 0);
    aggregated[key].views_3s += parseInt(row.views_3s || 0);
    aggregated[key].views_25 += parseInt(row.views_25 || 0);
    aggregated[key].views_50 += parseInt(row.views_50 || 0);
    aggregated[key].views_100 += parseInt(row.views_100 || 0);
  });
  
  // Calculate metrics
  Object.keys(aggregated).forEach(key => {
    const d = aggregated[key];
    d.roas = d.spend > 0 ? Math.round(d.revenue / d.spend) : 0;
    d.ctr = d.impressions > 0 ? parseFloat(((d.clicks / d.impressions) * 100).toFixed(2)) : 0;
    d.cpa = d.conversions > 0 ? parseFloat((d.spend / d.conversions).toFixed(2)) : 0;
    d.conversionRate = d.clicks > 0 ? parseFloat(((d.conversions / d.clicks) * 100).toFixed(2)) : 0;
    d.completionRate = d.video_starts > 0 ? parseFloat(((d.views_100 / d.video_starts) * 100).toFixed(2)) : 0;
    d.video_completion_rate = d.video_starts > 0 ? parseFloat(((d.views_100 / d.video_starts) * 100).toFixed(2)) : 0;
    d.cpm = d.impressions > 0 ? parseFloat(((d.spend / d.impressions) * 1000).toFixed(2)) : 0;
  });
  
  return aggregated;
}

// Agent 2: Answer Generator Agent
async function answerGeneratorAgent(userQuestion, queryResults, sql, goal, agentPrompt) {
  console.log('AnswerGeneratorAgent: Generating answer');
  
  // Extract conversation context and current question
  let contextString = '';
  let currentQuestion = userQuestion;
  
  if (userQuestion.includes('Previous conversation:') && userQuestion.includes('Current question:')) {
    const parts = userQuestion.split('Current question:');
    contextString = parts[0].trim();
    currentQuestion = parts[1].trim();
  }
  
  // Detect if this is a strategy question
  const isStrategy = isStrategyQuery(currentQuestion);
  
  // System prompt - concise and focused
  const systemPrompt = agentPrompt || `You are a marketing performance analyst. Transform data into actionable insights with precise numbers and clear recommendations.`;
  
  // Sort data by ROAS for better analysis
  let sortedResults = queryResults;
  if (typeof queryResults === 'object' && !Array.isArray(queryResults)) {
    const entries = Object.entries(queryResults);
    entries.sort((a, b) => (b[1].roas || 0) - (a[1].roas || 0));
    sortedResults = Object.fromEntries(entries);
  }
  
  const formattedResults = JSON.stringify(sortedResults, null, 2);
  
  let userPrompt;
  
if (isStrategy) {
  // Strategy prompt with goal awareness
  let strategyMetric = '';
  let strategyInstructions = '';
  
  if (goal === 'AWARENESS') {
    strategyMetric = 'CPM (cost per 1000 impressions)';
    strategyInstructions = `- For CUT: Remove budget from highest CPM (least efficient) platforms
- For ADD: Allocate to lowest CPM platforms (most reach per dollar)
- For REALLOCATE: Move from high CPM to low CPM platforms`;
  } else if (goal === 'ENGAGEMENT') {
    strategyMetric = 'CTR and cost per click';
    strategyInstructions = `- For CUT: Remove from lowest CTR platforms
- For ADD: Allocate to highest CTR platforms
- For REALLOCATE: Move from low CTR to high CTR platforms`;
  } else {
    strategyMetric = 'ROAS';
    strategyInstructions = `- For CUT: Remove from lowest ROAS segments until target reached
- For ADD: Distribute using performance tiers (50% top, 30% mid, 20% low)
- For REALLOCATE: Move 30-40% from worst to best performers`;
  }
  
  userPrompt = `Analyze this marketing data and provide strategic recommendations.
<conversation_context>
"""
${contextString}
"""
</conversation_context>
<current_question>
"""
${currentQuestion}
"""
</current_question>
<context>
SQL Query: ${sql}
</context>
<data>
"""
${formattedResults}
"""
</data>
<goal_context>
User's optimization goal: ${goal}
Key metric to optimize: ${strategyMetric}
</goal_context>
<instructions>
Step 1: Read the conversation context. When the user uses pronouns like "there", "it", "that", refer to the previously mentioned item.
Step 2: Identify the budget action type
- CUT: "reduce budget", "cut $X", "save money" → Decrease total budget
- ADD: "have $X to invest", "extra budget", "additional $X" → Increase total budget  
- REALLOCATE: "optimize", "shift", "move budget" → Keep total budget same
Step 3: Identify the dimension in the data
- Look at the data keys: platform, region, age_group, or gender
Step 4: Apply the appropriate strategy based on the goal
${strategyInstructions}
Step 5: Calculate exact impact using the key metric (${strategyMetric})
</instructions>
<formatting>
"""
- Bold all numbers: **$75,000**, **5x**, **2.5%**
- Bold all segments: **TikTok**, **Northeast**, **18-24**
- Use bullet points with → arrows
- Never use markdown tables
"""
</formatting>
<examples>
Example 1 - Adding Budget for ${goal}:
User: "I have $100k to invest"
Response Structure:
**Current Performance (${strategyMetric}):**
→ Platform rankings by ${strategyMetric}
**Recommendation:**
Add **$100k** distributed by ${strategyMetric} performance

Example 2 - Cutting Budget:
User: "Cut $100k from total budget"
Response Structure:
**Recommendation:**
Remove **$100k** from worst ${strategyMetric} performers
</examples>
Generate your response following the structure shown in the examples.`;
    
} else {
  // Regular query prompt with goal-specific handling
  
  // Add goal-specific instructions
  let goalInstructions = '';
  
  if (goal === 'AWARENESS') {
    goalInstructions = `
<goal_context>
The user's goal is BRAND AWARENESS. They want to maximize reach and visibility.
</goal_context>

<metrics_priority>
Step 1: Lead with total impressions (reach metrics)
Step 2: Calculate and emphasize CPM (cost per 1000 impressions)  
Step 3: Identify platforms with lowest CPM (most efficient for reach)
Step 4: DO NOT lead with ROAS or revenue for awareness questions
</metrics_priority>

<example_response_pattern>
Good: "YouTube delivers the highest reach with **147M impressions** at **$0.48 CPM**, making it the most cost-efficient for brand visibility."
Bad: "TikTok has the highest ROAS at 8x..."
</example_response_pattern>`;
  } else if (goal === 'ENGAGEMENT') {
    goalInstructions = `
<goal_context>
The user's goal is ENGAGEMENT. They want clicks, traffic, and interactions.
</goal_context>

<metrics_priority>
Step 1: Lead with CTR and total clicks
Step 2: Show video completion rates if relevant
Step 3: Calculate cost per click
Step 4: Identify platforms with highest engagement rates
</metrics_priority>`;
  } else {
    // CONVERSION (default)
    goalInstructions = `
<goal_context>
The user's goal is CONVERSIONS/SALES. They want revenue and ROI.
</goal_context>

<metrics_priority>
Step 1: Lead with ROAS and revenue metrics
Step 2: Show CPA and conversion rates
Step 3: Focus on profitability and efficiency
</metrics_priority>`;
  }
  
  userPrompt = `Answer this marketing question using the provided data.

${goalInstructions}

<conversation_context>
"""
${contextString}
"""
</conversation_context>

<current_question>
"""
${currentQuestion}
"""
</current_question>

<pronoun_resolution>
When the user says "there", "it", "that", or "those", check the conversation context to identify what they're referring to.
Examples:
- "How much am I spending there?" where context shows TikTok was just discussed = Answer only about TikTok spend
- "What about that platform?" where context shows Instagram was mentioned = Answer about Instagram
</pronoun_resolution>

<context>
SQL Query: ${sql}
</context>

<data>
"""
${formattedResults}
"""
</data>

<instructions>
Step 1: Read the goal_context to understand what metrics matter most
Step 2: Check if the user is using pronouns that refer to previous context
Step 3: Analyze data focusing on the metrics_priority for this goal
Step 4: Structure response to lead with most relevant metrics
Step 5: Make recommendations based on the goal (e.g., lowest CPM for awareness)
Step 6: Keep response concise (2-3 paragraphs maximum)
</instructions>

<formatting>
"""
- Bold all numbers: **2.5%**, **$450k**
- Bold dimension values: **TikTok**, **male**
- Use → arrows for lists
- No markdown tables
"""
</formatting>

<example>
Context: User previously asked about TikTok
Question: "How much am I spending there?"
Response: You're spending **$70,493** on **TikTok**.

Question: "Which gender has highest CTR?"
Response: The gender with the highest **CTR** is **unknown** at **2.5%**, followed by **male** at **2.4%** and **female** at **2.2%**.
</example>

Generate your answer now.`;
}
  
  try {
    const response = await callLLM(systemPrompt, userPrompt, isStrategy ? 2000 : 1500);
    return response;
    
  } catch (error) {
    console.error('Error in answerGeneratorAgent:', error);
    return formatDataFallback(sortedResults);
  }
}

// Fallback formatting if answer agent fails
function formatDataFallback(results) {
  let output = "Here's what I found:\n\n";
  
  if (typeof results === 'object' && results !== null) {
    Object.keys(results).forEach(key => {
      const data = results[key];
      if (typeof data === 'object') {
        output += `**${key}**\n`;
        if (data.roas) output += `→ ROAS: **${data.roas}x**\n`;
        if (data.spend) output += `→ Spend: **$${(data.spend/1000).toFixed(1)}k**\n`;
        if (data.revenue) output += `→ Revenue: **$${(data.revenue/1000).toFixed(1)}k**\n`;
        if (data.ctr) output += `→ CTR: **${data.ctr}%**\n`;
        output += '\n';
      }
    });
  }
  
  return output;
}


// Main chat endpoint
app.post('/chat', async (req, res) => {
  try {
    const { message, conversationHistory } = req.body;
    
    console.log('\n=== New Chat Request ===');
    console.log('User message:', message);
    
    // Track analysis steps
    const analysisSteps = [];
    
    // Step 1: Understanding
    analysisSteps.push(`🤔 User is asking: "${message}"`);
    
    // Build conversation context
    let contextString = '';
    if (conversationHistory && conversationHistory.length > 0) {
      contextString = 'Previous conversation:\n';
      conversationHistory.forEach(msg => {
        contextString += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
      });
      contextString += '\n';
    }

    // Extract previous goal from conversation history
    let previousGoal = null;
    if (conversationHistory && conversationHistory.length > 0) {
      // Look through history from newest to oldest to find the most recent goal
      for (let i = conversationHistory.length - 1; i >= 0; i--) {
        if (conversationHistory[i].goal) {
          previousGoal = conversationHistory[i].goal;
          break;
        }
      }
    }
    
    // Add previous goal to context
    if (previousGoal) {
      contextString += `Previous query goal: ${previousGoal}\n\n`;
    }
    
    // Then your existing queryGeneratorAgent call continues as normal:
    // const queryResult = await queryGeneratorAgent(
    //   contextString + 'Current question: ' + message
    // );
    
    // Query Generator Agent
    analysisSteps.push('🔍 Analyzing what data is needed...');
    const queryResult = await queryGeneratorAgent(
      contextString + 'Current question: ' + message
    );
    
    // If not SQL (conversational response), return immediately
    if (!queryResult.isSQL) {
      console.log('Conversational response returned');
      return res.json({
        success: true,
        sql: null,
        answer: queryResult.content,
        visualization: null,
        analysisSteps: analysisSteps
      });
    }
    
    let sql = queryResult.content;
    
    // Remove trailing semicolon if present
    sql = sql.replace(/;\s*$/, '').trim();
    
    // Extract what we're analyzing from SQL
    if (sql.includes('video_ad_performance')) {
      analysisSteps.push('🗄️ Accessing: video_ad_performance table');
    }
    
    // Detect what metrics we're looking at
    const metrics = [];
    if (sql.includes('SUM(revenue) / NULLIF(SUM(spend)')) metrics.push('ROAS');
    if (sql.includes('SUM(clicks)') && sql.includes('impressions')) metrics.push('CTR');
    if (sql.includes('SUM(spend) / NULLIF(SUM(conversions)')) metrics.push('CPA');
    if (sql.includes('views_100')) metrics.push('Video Completion Rate');
    
    if (metrics.length > 0) {
      analysisSteps.push(`📊 Calculating: ${metrics.join(', ')}`);
    }
    
    // Detect grouping
    const groupByMatch = sql.match(/GROUP BY\s+(\w+)/i);
    if (groupByMatch) {
      analysisSteps.push(`🎯 Comparing by: ${groupByMatch[1]}`);
    }
    
    console.log('Generated SQL:', sql);
    
    // Step 2: Validate SQL
    const validation = validateSQL(sql);
    if (!validation.valid) {
      console.log('SQL validation failed:', validation.error);
      return res.json({
        success: false,
        sql: sql,
        answer: "I had trouble creating a safe query for that question. Could you try asking in a different way?",
        visualization: null,
        analysisSteps: analysisSteps
      });
    }
    
    // Step 3: Execute SQL and aggregate
    analysisSteps.push('🔄 Running analysis on October 2025 data...');
    let result;
    try {
      result = await executeAndAggregate(sql, message, queryResult.goal);
      console.log('Query executed successfully');
      
      // Add data volume info
      if (result.rawData && typeof result.rawData === 'object') {
        const count = Object.keys(result.rawData).length;
        analysisSteps.push(`📈 Found: ${count} data segments to analyze`);
      }
      
    } catch (error) {
      console.log('SQL execution failed:', error.message);
      return res.json({
        success: false,
        sql: sql,
        answer: "I ran into an issue retrieving that data. Could you try rephrasing your question? For example: 'Which platform has the best ROAS?' or 'Show me conversion rates by age group'",
        visualization: null,
        analysisSteps: analysisSteps
      });
    }
    
    // Step 4: Answer Generator Agent
    analysisSteps.push('✍️ Generating insights and recommendations...');
    const answer = await answerGeneratorAgent(
      contextString + 'Current question: ' + message,
      result.rawData,
      sql,
      queryResult.goal  // Pass the goal here
      
    );
    
    if (result.visualization) {
      analysisSteps.push('📊 Preparing visualization...');
    }
    
    console.log('Answer generated successfully');
    console.log('Visualization type:', result.visualization ? result.visualization.type : 'none');
    
    res.json({
      success: true,
      sql: sql,
      answer: answer,
      visualization: result.visualization,
      analysisSteps: analysisSteps, // NEW: Send analysis steps
      goal: queryResult.goal 
    });
    
  } catch (error) {
    console.error('Error in chat endpoint:', error);
    res.json({
      success: false,
      sql: null,
      answer: 'I encountered an unexpected error. Please try again or rephrase your question.',
      visualization: null,
      analysisSteps: ['🤔 Understanding request...', '❌ Encountered an error']
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    model: MODEL_NAME,
    agents: ['queryGeneratorAgent', 'answerGeneratorAgent']
  });
});
app.listen(PORT, () => {
  console.log(`\n🚀 AdAgentOS Backend running on port ${PORT}`);
  console.log(`📊 Using model: ${MODEL_NAME}`);
  console.log(`🤖 Active agents: Query Generator + Answer Generator\n`);
});

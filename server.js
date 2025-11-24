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
async function queryGeneratorAgent(userQuestion, agentPrompt) {
  console.log('QueryGeneratorAgent: Processing question:', userQuestion);
  
  const systemPrompt = agentPrompt || `You are an expert SQL query generator for marketing analytics. Generate safe, efficient PostgreSQL queries based on user questions and the provided schema.`;
  
  const userPrompt = `${DATABASE_SCHEMA}

User Question: "${userQuestion}"

Your task:
1. If the question can be answered with the available data, generate a valid PostgreSQL SELECT query
2. If the question asks for data not available in the schema (e.g., platforms not in the list, metrics not calculable), respond with a conversational message explaining what data IS available
3. If the question is too vague, ask a clarifying question naturally

Response Format:
- If generating SQL: Return ONLY the SQL query WITHOUT semicolon at the end
- If data not available: Return a natural conversational response like "I don't have [X] data, but I can show you [Y]. Would you like that?"
- If clarification needed: Ask a natural question like "I can help! Are you interested in ROAS, conversion rates, or something else?"

IMPORTANT - Strategy Questions:
If the user asks for investment advice, budget allocation, optimization suggestions, or strategic recommendations, ALWAYS generate SQL to fetch performance data. DO NOT ask clarifying questions for these queries.

Strategy question indicators:
- "Where should I invest..."
- "How can I improve..."
- "Which platforms should I optimize..."
- "Where should I reallocate budget..."
- "What should I do..."
- "How to maximize..."
- "Best way to increase..."
- "Should I shift budget..."

For strategy questions, generate SQL to get platform performance data (include spend, revenue, ROAS, conversions, etc.) using GROUP BY platform and ORDER BY roas DESC, so the analysis agent can provide data-driven recommendations.

Examples:

Q: "Which platform has best ROAS?"
A: SELECT platform, SUM(revenue) / NULLIF(SUM(spend), 0) as roas, SUM(spend) as total_spend, SUM(revenue) as total_revenue FROM video_ad_performance WHERE report_month = '2025-10-01' GROUP BY platform ORDER BY roas DESC

Q: "Where should I invest more budget?"
A: SELECT platform, SUM(spend) as total_spend, SUM(revenue) as total_revenue, SUM(revenue) / NULLIF(SUM(spend), 0) as roas, SUM(conversions) as total_conversions FROM video_ad_performance WHERE report_month = '2025-10-01' GROUP BY platform ORDER BY roas DESC

Q: "What's my Twitter performance?"
A: I don't have Twitter data in the system. I can analyze TikTok, Instagram, Facebook, YouTube, or Snapchat. Which would you like to see?

Q: "Show me the data"
A: I can help! What would you like to explore? Performance by platform, region, age group, or specific metrics like ROAS or conversion rates?

Generate response now:`;

  try {
    const response = await callLLM(systemPrompt, userPrompt, 1000);
    
    // Check if response is SQL or conversational
    const isSQL = response.toUpperCase().includes('SELECT') && 
                   response.toUpperCase().includes('FROM');
    
    return { isSQL, content: response };
    
  } catch (error) {
    console.error('Error in queryGeneratorAgent:', error);
    throw new Error('I had trouble understanding that question. Could you rephrase it?');
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
function detectRequestedMetrics(sql, userQuestion) {
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
async function executeAndAggregate(sql, userQuestion) {
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
    const requestedMetrics = detectRequestedMetrics(sql, userQuestion);
    
    return {
      visualization: {
        type: 'comparison',
        dimension: visualization.dimension,
        requestedMetrics: requestedMetrics,  // NEW: Pass requested metrics
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
async function answerGeneratorAgent(userQuestion, queryResults, sql, agentPrompt) {
  console.log('AnswerGeneratorAgent: Generating answer');
  
  // Detect if this is a strategy question
  const isStrategy = isStrategyQuery(userQuestion);
  
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
    // Strategy prompt using best practices
    userPrompt = `Analyze this marketing data and provide strategic recommendations.

<context>
User Question: "${userQuestion}"
SQL Query: ${sql}
</context>

<data>
${formattedResults}
</data>

<instructions>
Step 1: Identify the budget action type
- CUT: "reduce budget", "cut $X", "save money" → Decrease total budget
- ADD: "have $X to invest", "extra budget", "additional $X" → Increase total budget  
- REALLOCATE: "optimize", "shift", "move budget" → Keep total budget same

Step 2: Identify the dimension in the data
- Look at the data keys: platform, region, age_group, or gender

Step 3: Apply the appropriate strategy
- For CUT: Remove from lowest ROAS segments until target reached
- For ADD: Distribute using performance tiers (50% top, 30% mid, 20% low)
- For REALLOCATE: Move 30-40% from worst to best performers

Step 4: Calculate exact impact using actual ROAS values
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
Example 1 - Adding New Budget:
User: "I have $100k to distribute across platforms"
Response Structure:
**Current Performance:**
→ **TikTok**: **$70k** spend, **8x** ROAS
→ **YouTube**: **$71k** spend, **5x** ROAS
[etc.]

**Recommendation:**
Add **$100k** distributed by performance:
→ **TikTok**: +**$50k** (top tier gets 50%)
→ **YouTube**: +**$30k** (second tier gets 30%)
→ **Instagram**: +**$20k** (lower tiers share 20%)

Example 2 - Cutting Budget:
User: "Cut $100k from total budget"
Response Structure:
**Recommendation:**
Remove **$100k** from lowest performers:
→ **Facebook**: -**$50k** (from **$71k** to **$21k**)
→ **Snapchat**: -**$50k** (from **$73k** to **$23k**)
Total budget: **$360k** → **$260k**
</examples>

Generate your response following the structure shown in the examples.`;
    
  } else {
    // Regular query prompt - simplified
    userPrompt = `Answer this marketing question using the provided data.

<context>
User Question: "${userQuestion}"
SQL Query: ${sql}
</context>

<data>
${formattedResults}
</data>

<instructions>
1. Answer the question directly using exact numbers from the data
2. Keep response concise (2-3 paragraphs maximum)
3. Use conversational tone
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
    const { message, agentPrompts } = req.body;
    
    console.log('\n=== New Chat Request ===');
    console.log('User message:', message);
    
    // Step 1: Query Generator Agent
    const queryResult = await queryGeneratorAgent(
      message, 
      agentPrompts?.queryGeneratorAgent
    );
    
    // If not SQL (conversational response), return immediately
    if (!queryResult.isSQL) {
      console.log('Conversational response returned');
      return res.json({
        success: true,
        sql: null,
        answer: queryResult.content,
        visualization: null
      });
    }
    
    let sql = queryResult.content;
    
    // Remove trailing semicolon if present
    sql = sql.replace(/;\s*$/, '').trim();
    
    console.log('Generated SQL:', sql);
    
    // Step 2: Validate SQL
    const validation = validateSQL(sql);
    if (!validation.valid) {
      console.log('SQL validation failed:', validation.error);
      return res.json({
        success: false,
        sql: sql,
        answer: "I had trouble creating a safe query for that question. Could you try asking in a different way?",
        visualization: null
      });
    }
    
    // Step 3: Execute SQL and aggregate (now with userQuestion for metric detection)
    let result;
    try {
      result = await executeAndAggregate(sql, message);
      console.log('Query executed successfully');
      
    } catch (error) {
      console.log('SQL execution failed:', error.message);
      return res.json({
        success: false,
        sql: sql,
        answer: "I ran into an issue retrieving that data. Could you try rephrasing your question? For example: 'Which platform has the best ROAS?' or 'Show me conversion rates by age group'",
        visualization: null
      });
    }
    
    // Step 4: Answer Generator Agent
    const answer = await answerGeneratorAgent(
      message,
      result.rawData,
      sql,
      agentPrompts?.answerGeneratorAgent
    );
    
    console.log('Answer generated successfully');
    console.log('Visualization type:', result.visualization ? result.visualization.type : 'none');
    
    res.json({
      success: true,
      sql: sql,
      answer: answer,
      visualization: result.visualization
    });
    
  } catch (error) {
    console.error('Error in chat endpoint:', error);
    res.json({
      success: false,
      sql: null,
      answer: 'I encountered an unexpected error. Please try again or rephrase your question.',
      visualization: null
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

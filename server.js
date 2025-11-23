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
- If generating SQL: Return ONLY the SQL query, nothing else
- If data not available: Return a natural conversational response like "I don't have [X] data, but I can show you [Y]. Would you like that?"
- If clarification needed: Ask a natural question like "I can help! Are you interested in ROAS, conversion rates, or something else?"

Examples:
Q: "Which platform has best ROAS?"
A: SELECT platform, SUM(revenue) / NULLIF(SUM(spend), 0) as roas, SUM(spend) as total_spend, SUM(revenue) as total_revenue FROM video_ad_performance WHERE report_month = '2025-10-01' GROUP BY platform ORDER BY roas DESC

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
  
  // Check for semicolons (prevents multiple queries)
  if (sql.includes(';')) {
    return { valid: false, error: 'Multiple queries not allowed' };
  }
  
  // Must reference the correct table
  if (!upperSQL.includes('VIDEO_AD_PERFORMANCE')) {
    return { valid: false, error: 'Invalid table reference' };
  }
  
  return { valid: true };
}

// Execute SQL and aggregate data
async function executeAndAggregate(sql) {
  console.log('Executing SQL...');
  
  try {
    // Fetch all data from Supabase
    const { data, error } = await supabase
      .from('video_ad_performance')
      .select('*')
      .eq('report_month', '2025-10-01');
    
    if (error) throw error;
    
    // Determine what aggregation to perform based on SQL
    const upperSQL = sql.toUpperCase();
    
    // Check which dimensions are in GROUP BY
    const groupByPlatform = upperSQL.includes('GROUP BY PLATFORM');
    const groupByRegion = upperSQL.includes('GROUP BY REGION');
    const groupByAgeGroup = upperSQL.includes('GROUP BY AGE_GROUP');
    const groupByGender = upperSQL.includes('GROUP BY GENDER');
    
    // Check for WHERE filters
    let filteredData = data;
    
    // Extract WHERE conditions
    if (upperSQL.includes('WHERE')) {
      const whereMatch = sql.match(/WHERE\s+(.+?)\s+(GROUP|ORDER|LIMIT|$)/i);
      if (whereMatch) {
        const whereClause = whereMatch[1];
        
        // Parse simple WHERE conditions
        if (whereClause.includes('platform')) {
          const platformMatch = whereClause.match(/platform\s*=\s*'([^']+)'/i);
          if (platformMatch) {
            filteredData = filteredData.filter(row => row.platform === platformMatch[1]);
          }
        }
        if (whereClause.includes('region')) {
          const regionMatch = whereClause.match(/region\s*=\s*'([^']+)'/i);
          if (regionMatch) {
            filteredData = filteredData.filter(row => row.region === regionMatch[1]);
          }
        }
        if (whereClause.includes('age_group')) {
          const ageMatch = whereClause.match(/age_group\s*=\s*'([^']+)'/i);
          if (ageMatch) {
            filteredData = filteredData.filter(row => row.age_group === ageMatch[1]);
          }
        }
      }
    }
    
    // Perform aggregation
    let aggregated = {};
    
    if (groupByPlatform) {
      aggregated = aggregateByDimension(filteredData, 'platform');
    } else if (groupByRegion) {
      aggregated = aggregateByDimension(filteredData, 'region');
    } else if (groupByAgeGroup) {
      aggregated = aggregateByDimension(filteredData, 'age_group');
    } else if (groupByGender) {
      aggregated = aggregateByDimension(filteredData, 'gender');
    } else {
      // Default: aggregate by platform
      aggregated = aggregateByDimension(filteredData, 'platform');
    }
    
    return aggregated;
    
  } catch (error) {
    console.error('SQL Execution Error:', error);
    throw error;
  }
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
    d.cpm = d.impressions > 0 ? parseFloat(((d.spend / d.impressions) * 1000).toFixed(2)) : 0;
  });
  
  return aggregated;
}

// Agent 2: Answer Generator Agent
async function answerGeneratorAgent(userQuestion, queryResults, sql, agentPrompt) {
  console.log('AnswerGeneratorAgent: Generating answer');
  
  const systemPrompt = agentPrompt || `You are a marketing performance analyst. Provide specific, data-driven insights with exact numbers from the query results. Always cite actual platform names, dollar amounts, and percentages from the data.`;
  
  const formattedResults = JSON.stringify(queryResults, null, 2);
  
  const userPrompt = `User Question: "${userQuestion}"

SQL Query Executed:
${sql}

Query Results:
${formattedResults}

Your task:
1. Analyze the actual data from the query results
2. Answer the user's question DIRECTLY with SPECIFIC numbers (exact platform names, dollar amounts, percentages)
3. ONLY provide recommendations if the user's question explicitly asks for advice, strategy, or recommendations (e.g., "where should I invest", "what should I do", "how can I improve")
4. If the user just asks for data or metrics, simply present the findings without unsolicited advice
5. Use a professional but conversational tone
6. Keep response concise (2-3 paragraphs max for data queries, 3-4 for strategy questions)

CRITICAL: You must use the ACTUAL numbers from the query results. Do not make up or estimate numbers.

Example good response:
"Facebook shows the highest ROAS at 12.26x with $49,234 in spend, generating $603,421 in revenue. Meanwhile, TikTok has a lower ROAS of 10.08x but receives significantly more budget at $87,123. 

I'd recommend reallocating $20,000 from TikTok to Facebook, which based on Facebook's current performance could generate an additional $245,200 in revenue. Additionally, TikTok's lower ROAS suggests we should review creative performance and audience targeting."

Generate your answer now:`;

  try {
    const response = await callLLM(systemPrompt, userPrompt, 1500);
    return response;
    
  } catch (error) {
    console.error('Error in answerGeneratorAgent:', error);
    return formatDataFallback(queryResults);
  }
}

// Fallback formatting if answer agent fails
function formatDataFallback(results) {
  let output = "Here's what I found:\n\n";
  
  Object.keys(results).forEach(key => {
    const data = results[key];
    output += `**${key}**\n`;
    if (data.roas) output += `- ROAS: ${data.roas}x\n`;
    if (data.spend) output += `- Spend: $${(data.spend/1000).toFixed(1)}k\n`;
    if (data.revenue) output += `- Revenue: $${(data.revenue/1000).toFixed(1)}k\n`;
    if (data.ctr) output += `- CTR: ${data.ctr}%\n`;
    output += '\n';
  });
  
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
        metrics: null
      });
    }
    
    const sql = queryResult.content;
    console.log('Generated SQL:', sql);
    
    // Step 2: Validate SQL
    const cleanedSQL = sql.replace(/;\s*$/, '').trim();
    const validation = validateSQL(cleanedSQL);
    if (!validation.valid) {
      console.log('SQL validation failed:', validation.error);
      return res.json({
        success: false,
        sql: sql,
        answer: "I had trouble creating a safe query for that question. Could you try asking in a different way?",
        metrics: null
      });
    }
    
    // Step 3: Execute SQL and aggregate
    let queryResults;
    try {
      queryResults = await executeAndAggregate(sql);
      console.log('Query executed successfully');
      
    } catch (error) {
      console.log('SQL execution failed:', error.message);
      return res.json({
        success: false,
        sql: sql,
        answer: "I ran into an issue retrieving that data. Could you try rephrasing your question? For example: 'Which platform has the best ROAS?' or 'Show me conversion rates by age group'",
        metrics: null
      });
    }
    
    // Step 4: Answer Generator Agent
    const answer = await answerGeneratorAgent(
      message,
      queryResults,
      sql,
      agentPrompts?.answerGeneratorAgent
    );
    
    console.log('Answer generated successfully');
    
    res.json({
      success: true,
      sql: sql,
      answer: answer,
      metrics: queryResults
    });
    
  } catch (error) {
    console.error('Error in chat endpoint:', error);
    res.json({
      success: false,
      sql: null,
      answer: 'I encountered an unexpected error. Please try again or rephrase your question.',
      metrics: null
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

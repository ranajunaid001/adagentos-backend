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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Agent 1: Data Agent - Fetches data from Supabase
async function dataAgent(query) {
  console.log('DataAgent: Processing query:', query);
  
  // Parse intent and determine what data to fetch
  const lowerQuery = query.toLowerCase();
  
  if (lowerQuery.includes('cross channel') || lowerQuery.includes('summary') || lowerQuery.includes('october')) {
    // Get platform summary for October
    const { data, error } = await supabase
      .from('video_ad_performance')
      .select('platform, spend, impressions, clicks, conversions, revenue')
      .eq('report_month', '2025-10-01');
    
    if (error) throw error;
    
    // Aggregate by platform
    const platformSummary = {};
    data.forEach(row => {
      if (!platformSummary[row.platform]) {
        platformSummary[row.platform] = {
          spend: 0,
          impressions: 0,
          clicks: 0,
          conversions: 0,
          revenue: 0
        };
      }
      platformSummary[row.platform].spend += parseFloat(row.spend || 0);
      platformSummary[row.platform].impressions += parseInt(row.impressions || 0);
      platformSummary[row.platform].clicks += parseInt(row.clicks || 0);
      platformSummary[row.platform].conversions += parseInt(row.conversions || 0);
      platformSummary[row.platform].revenue += parseFloat(row.revenue || 0);
    });
    
    return platformSummary;
  }
  
  if (lowerQuery.includes('roas') && lowerQuery.includes('west')) {
    // Get ROAS by platform in West region
    const { data, error } = await supabase
      .from('video_ad_performance')
      .select('platform, spend, revenue')
      .eq('report_month', '2025-10-01')
      .eq('region', 'West');
    
    if (error) throw error;
    
    // Calculate ROAS by platform
    const platformROAS = {};
    const platformData = {};
    
    data.forEach(row => {
      if (!platformData[row.platform]) {
        platformData[row.platform] = { spend: 0, revenue: 0 };
      }
      platformData[row.platform].spend += parseFloat(row.spend || 0);
      platformData[row.platform].revenue += parseFloat(row.revenue || 0);
    });
    
    Object.keys(platformData).forEach(platform => {
      const spend = platformData[platform].spend;
      const revenue = platformData[platform].revenue;
      platformROAS[platform] = {
        spend,
        revenue,
        roas: spend > 0 ? (revenue / spend).toFixed(2) : 0
      };
    });
    
    return platformROAS;
  }
  
  // Default: return overall summary
  const { data, error } = await supabase
    .from('video_ad_performance')
    .select('*')
    .eq('report_month', '2025-10-01')
    .limit(100);
  
  if (error) throw error;
  return data;
}

// Agent 2: Analysis Agent - Analyzes the data
function analysisAgent(data) {
  console.log('AnalysisAgent: Analyzing data');
  
  const analysis = {
    metrics: {},
    insights: []
  };
  
  // If it's platform summary data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    Object.keys(data).forEach(platform => {
      const platformData = data[platform];
      
      // Calculate key metrics
      const ctr = platformData.impressions > 0 
        ? ((platformData.clicks / platformData.impressions) * 100).toFixed(2)
        : 0;
      
      const conversionRate = platformData.clicks > 0
        ? ((platformData.conversions / platformData.clicks) * 100).toFixed(2)
        : 0;
      
      const cpa = platformData.conversions > 0
        ? (platformData.spend / platformData.conversions).toFixed(2)
        : 0;
      
      const roas = platformData.spend > 0
        ? (platformData.revenue / platformData.spend).toFixed(2)
        : 0;
      
      analysis.metrics[platform] = {
        ...platformData,
        ctr: parseFloat(ctr),
        conversionRate: parseFloat(conversionRate),
        cpa: parseFloat(cpa),
        roas: parseFloat(roas)
      };
    });
    
    // Generate insights
    const platforms = Object.keys(analysis.metrics);
    
    // Find best and worst performers
    let bestROAS = { platform: null, value: 0 };
    let worstROAS = { platform: null, value: Infinity };
    let highestSpend = { platform: null, value: 0 };
    
    platforms.forEach(platform => {
      const metrics = analysis.metrics[platform];
      
      if (metrics.roas > bestROAS.value) {
        bestROAS = { platform, value: metrics.roas };
      }
      
      if (metrics.roas < worstROAS.value && metrics.spend > 0) {
        worstROAS = { platform, value: metrics.roas };
      }
      
      if (metrics.spend > highestSpend.value) {
        highestSpend = { platform, value: metrics.spend };
      }
    });
    
    analysis.insights.push(`Best ROAS: ${bestROAS.platform} at ${bestROAS.value}x`);
    analysis.insights.push(`Worst ROAS: ${worstROAS.platform} at ${worstROAS.value}x`);
    analysis.insights.push(`Highest spend: ${highestSpend.platform} at $${highestSpend.value.toFixed(2)}`);
  }
  
  return analysis;
}

// Agent 3: Optimization Agent - Uses LLM to generate recommendations
async function optimizationAgent(analysisData, userQuery, agentPrompts) {
  console.log('OptimizationAgent: Generating recommendations');
  
  // Prepare prompt for LLM
  const systemPrompt = agentPrompts?.optimizationAgent || `You are a marketing optimization specialist. Provide specific, actionable recommendations based on the data.`;
  
  const userPrompt = `
Based on this video ad campaign performance data, provide recommendations.

User Question: ${userQuery}

Performance Metrics by Platform:
${JSON.stringify(analysisData.metrics, null, 2)}

Key Insights:
${analysisData.insights.join('\n')}

Please provide:
1. A brief diagnosis of the current performance
2. 3-5 specific recommendations with exact percentages or dollar amounts
3. Focus on ROI improvement opportunities

Keep your response concise and actionable.`;

  try {
    let response;
    
    if (MODEL_NAME.includes('claude')) {
      // Use Anthropic API
      const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: MODEL_NAME,
          max_tokens: 500,
          messages: [
            { role: 'user', content: userPrompt }
          ],
          system: systemPrompt
        })
      });
      
      const data = await anthropicResponse.json();
      response = data.content[0].text;
      
    } else {
      // Use OpenAI API
      const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
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
          temperature: 0.7,
          max_tokens: 500
        })
      });
      
      const data = await openaiResponse.json();
      response = data.choices[0].message.content;
    }
    
    return response;
    
  } catch (error) {
    console.error('Error calling LLM:', error);
    
    // Fallback to rule-based recommendations
    const metrics = analysisData.metrics;
    const platforms = Object.keys(metrics);
    
    let recommendations = "**Performance Analysis:**\n\n";
    recommendations += "Based on the October campaign data:\n\n";
    
    // Find best and worst performers
    const roasValues = platforms.map(p => ({ platform: p, roas: metrics[p].roas }));
    roasValues.sort((a, b) => b.roas - a.roas);
    
    recommendations += `**Key Findings:**\n`;
    recommendations += `• Best performer: ${roasValues[0].platform} with ${roasValues[0].roas}x ROAS\n`;
    recommendations += `• Weakest performer: ${roasValues[roasValues.length - 1].platform} with ${roasValues[roasValues.length - 1].roas}x ROAS\n\n`;
    
    recommendations += `**Recommendations:**\n`;
    recommendations += `1. **Reallocate budget:** Shift 20% of ${roasValues[roasValues.length - 1].platform} budget to ${roasValues[0].platform}\n`;
    recommendations += `2. **Optimize targeting:** Focus ${roasValues[0].platform} on high-performing demographics\n`;
    recommendations += `3. **Creative refresh:** Update ${roasValues[roasValues.length - 1].platform} creative assets to improve engagement\n`;
    recommendations += `4. **Scale winners:** Increase ${roasValues[0].platform} budget by 15% to capture more conversions\n`;
    
    return recommendations;
  }
}

// Main chat endpoint
app.post('/chat', async (req, res) => {
  try {
    const { message, agentPrompts } = req.body;
    
    // Step 1: Data Agent fetches data
    const data = await dataAgent(message);
    
    // Step 2: Analysis Agent analyzes data
    const analysis = analysisAgent(data);
    
    // Step 3: Optimization Agent generates recommendations
    const recommendations = await optimizationAgent(analysis, message, agentPrompts);
    
    res.json({
      message: recommendations,
      metrics: analysis.metrics
    });
    
  } catch (error) {
    console.error('Error in chat endpoint:', error);
    res.status(500).json({
      message: 'Sorry, I encountered an error processing your request. Please try again.',
      error: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', model: MODEL_NAME });
});

app.listen(PORT, () => {
  console.log(`AdAgentOS Backend running on port ${PORT}`);
  console.log(`Using model: ${MODEL_NAME}`);
});

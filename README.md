# AdAgentOS Backend

## Setup Instructions

### 1. Environment Variables
Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Then fill in:
- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_ANON_KEY`: Your Supabase anon key
- `MODEL_NAME`: Either `gpt-4o-mini` or `claude-3-5-sonnet-20241022`
- API key for your chosen model

### 2. Deploy to Railway

1. Push to GitHub:
```bash
git add .
git commit -m "Add AdAgentOS backend"
git push
```

2. In Railway:
- Create new project from GitHub repo
- Add environment variables from your `.env`
- Railway will auto-detect Node.js and run `npm start`

### 3. Update Frontend

After deploying backend, update the frontend's `index.html`:
- Replace `http://localhost:3000/chat` with your Railway backend URL
- Example: `https://your-backend.railway.app/chat`

## How It Works

The backend implements three agents:

1. **DataAgent**: Fetches data from Supabase based on user query
2. **AnalysisAgent**: Calculates metrics (ROAS, CTR, CPA) from raw data
3. **OptimizationAgent**: Uses LLM to generate specific recommendations

## Supported Queries

- "Give me a cross channel summary for October"
- "Which platform had the best ROAS in the West?"
- "Where is performance weakest?"
- "What should I do with my budget?"

## API Endpoints

- `POST /chat` - Main chat endpoint
- `GET /health` - Health check

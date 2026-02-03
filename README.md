# 🎯 GitHub Sitrep

An AI-powered tool that helps you understand what's happening in any public GitHub repository. Get instant insights, analyze bugs, and stay on top of development status with intelligent summaries powered by Claude AI.

## ✨ Features

- 🤖 **Chatbot Interface**: Ask natural language questions about repository issues
- ⚡️ **Quick Sitrep**: Instant overview of repository health and activity
- 🚨 **Recent Bugs**: Analysis of open bugs and their severity
- 🧟 **Zombie Tickets**: Identify and analyze stale issues
- 💾 **Local Caching**: SQLite database for fast queries and minimal API costs
- 🎯 **Two-Tier AI**: Haiku for indexing (fast/cheap), Opus for queries (smart/premium)

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ installed
- Anthropic API key ([get one here](https://console.anthropic.com/))

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd github-issues-sitrep
```

2. Install dependencies:
```bash
npm install
```

3. Configure your API key:
```bash
cp .env.example .env
```

Edit `.env` and add your Anthropic API key:
```
ANTHROPIC_API_KEY=your_actual_api_key_here
```

4. Start the server:
```bash
npm start
```

5. Open your browser to [http://localhost:3000](http://localhost:3000)

## 📖 How It Works

### Architecture

**Frontend**: Clean chatbot UI with vanilla HTML/CSS/JavaScript
**Backend**: Express.js server with RESTful API
**Database**: SQLite for local caching (zero config)
**AI**: Anthropic Claude API with two-tier strategy

### Two-Tier AI Strategy

To maximize quality while minimizing costs:

1. **Tier 1: Claude Haiku** (Background Processing)
   - Summarizes all issues when syncing
   - Generates cached starter reports
   - Cost: ~$0.15 for 600 issues (one-time)

2. **Tier 2: Claude Opus** (User Queries)
   - Answers custom questions with premium intelligence
   - Synthesizes complex patterns and recommendations
   - Cost: ~$0.20 per query

### Data Flow

```
First Sync:
├─ Fetch all issues from GitHub
├─ Store in SQLite database
├─ Generate AI summaries (Haiku)
├─ Pre-compute starter reports (Haiku)
└─ Ready! (subsequent queries are instant)

User Interactions:
├─ Starter buttons → Cached reports (instant, $0)
└─ Custom questions → Smart filtering + Opus ($0.20)
```

## 💰 Cost Estimates

For a repository with ~600 issues:

- **Initial sync**: ~$0.15 (one-time)
- **Starter buttons**: $0 (cached)
- **Custom questions**: ~$0.20 each
- **Weekly re-sync**: ~$0.02

Most queries are instant and free thanks to local caching!

## 🎮 Usage

### Configure a Repository

1. Enter any public GitHub repository (e.g., `openfn/lightning`)
2. Click "Connect"
3. Wait for the initial sync (30-60 seconds)

### Quick Actions

- **⚡️ Quick Sitrep**: Overall repository status and trends
- **🚨 Recent Bugs**: Analysis of open bugs and priorities
- **🧟 Zombie Tickets**: Stale issues that need attention

### Ask Questions

Type any question about the repository:
- "What are the highest priority issues?"
- "Show me security-related bugs"
- "What issues were created this month?"
- "Which tickets should we close?"

## 🔧 Configuration

### GitHub Token (Optional but Recommended)

Without a GitHub token, you're limited to 60 API requests per hour. With a token, you get 5000 requests per hour.

1. Create a Personal Access Token at [https://github.com/settings/tokens](https://github.com/settings/tokens)
2. Select scope: `public_repo` (read-only access)
3. Add to your `.env` file:
```
GITHUB_TOKEN=your_github_token_here
```

### Custom Port

Change the port in `.env`:
```
PORT=3001
```

## 📁 Project Structure

```
github-issues-sitrep/
├── server.js              # Express server & API routes
├── database.js            # SQLite setup & queries
├── github-sync.js         # GitHub API integration
├── ai-service.js          # Two-tier Claude AI service
├── package.json           # Dependencies
├── .env                   # Your configuration
├── sitrep.db             # SQLite database (auto-created)
└── public/
    ├── index.html        # Chatbot UI
    ├── styles.css        # Styling
    └── app.js            # Frontend logic
```

## 🧠 How It Saves Costs

1. **Local Database**: Most queries hit SQLite instead of APIs
2. **Smart Filtering**: Only sends relevant issues to Claude
3. **Cached Summaries**: Issues summarized once, reused forever
4. **Pre-computed Reports**: Starter buttons return cached results
5. **Incremental Syncs**: Only fetch changed issues on re-sync

## 🐛 Troubleshooting

### "Anthropic API key not configured"
Make sure your `.env` file has a valid `ANTHROPIC_API_KEY`.

### "Repository not found"
Ensure the repository is public and the format is `owner/name`.

### Sync takes a long time
First sync for large repos (1000+ issues) can take 2-3 minutes. Subsequent syncs are much faster.

### Reset cache / Database issues
To clear all cached data and start fresh:
```bash
npm run reset
```

Or manually delete the database files:
```bash
rm sitrep.db sitrep.db-shm sitrep.db-wal
```

After resetting, the next sync will fetch fresh data from GitHub.

## 🤝 Contributing

Contributions are welcome! This is a simple, focused tool designed to be easy to understand and extend.

## 📄 License

MIT

## 🙏 Credits

Built with:
- [Claude AI](https://www.anthropic.com/) by Anthropic
- [GitHub REST API](https://docs.github.com/en/rest)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [Octokit](https://github.com/octokit/octokit.js)

---

**Happy analyzing! 🎯**

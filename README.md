# task.airat.top

[![task.airat.top](https://repository-images.githubusercontent.com/1192079686/dd1f0633-9a18-46a5-aa6c-65964e3d57fa)](https://task.airat.top/)

Smart, local-first task manager with manual task planning and optional AI-assisted tagging/decomposition.

- Live site: https://task.airat.top
- Status page: https://status.airat.top

## Features

- Local task storage in the browser (`localStorage`).
- First-run demo task with tags, subtasks, priority, and due date.
- JSON export for all tasks.
- Fast add/complete/delete flow with progress stats and 3-second undo for deletes.
- Manual task ordering with drag-and-drop and up/down controls.
- Inline task editing.
- Task priorities: low, normal, high.
- Manual due dates with today/overdue status.
- Filters by task status, due date, and priority.
- Search by task title, generated tags, and subtask title.
- Manual tag editing: add and remove task tags.
- Manual subtasks: add, edit, complete, delete, and reorder.
- AI auto-tagging for new and edited tasks (Gemini).
- AI decomposition into actionable subtasks (Gemini).
- Literal `test` tasks are kept local and skipped from AI analysis.
- Theme switcher (light/dark/system).

## Tech Stack

- React 19
- TypeScript
- Vite 6
- Tailwind CSS 4
- Gemini API (`@google/genai`)

## Project Structure

- `src/` - application code.
- `public/` - static assets (`favicon`, `robots.txt`, `site.webmanifest`, `llms.txt`).
- `index.html` - app shell and meta tags.
- `vite.config.ts` - Vite config.

## Local Development

Prerequisites: Node.js 20+ and npm.

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create local env file and set Gemini key:
   ```bash
   cp .env.example .env.local
   ```
3. Run dev server:
   ```bash
   npm run dev
   ```
4. Open `http://localhost:3000`.

## Build

```bash
npm run build
npm run preview
```

## Cloudflare Pages

Use these settings for deployment:

- Project root: `/` (repository root)
- Build command: `npm run build`
- Build output directory: `dist`
- Environment variable: `GEMINI_API_KEY`
- Production URL: `https://task.airat.top`

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Author

**AiratTop**

- Website: [airat.top](https://airat.top)
- GitHub: [@AiratTop](https://github.com/AiratTop)
- Email: [mail@airat.top](mailto:mail@airat.top)
- Repository: [task.airat.top](https://github.com/AiratTop/task.airat.top)

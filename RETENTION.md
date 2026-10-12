# Clip retention

Clips expire 21 days after their `createdAt` timestamp. Upload runs also perform a cleanup pass, but that only handles expiry opportunistically.

For predictable deletion, schedule the cleanup command to run daily on a machine that has this project, its `.env`, and network access to MongoDB Atlas and Cloudflare R2:

```powershell
cd F:\Automation_tool
npm run cleanup
```

In Windows Task Scheduler, create a daily task with:

- Program: `npm.cmd`
- Arguments: `run cleanup`
- Start in: `F:\Automation_tool`

The cleanup removes an expired R2 object first, then deletes its MongoDB record. If R2 deletion fails, the record remains so a later run can retry. The task uses credentials from `.env`; never put credential values in the scheduled-task arguments.

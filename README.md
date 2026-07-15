# Automa Vault

A self-contained workflow, packages, variables, and credentials vault for Automa.

This repository stores all seed configurations for your projects and provides a lightweight CLI tool to synchronize data bi-directionally between local JSON files and target Supabase databases.

---

## 📂 Directory Structure

```text
automa-vault/
  ├── <projectName>/             # e.g., crm/
  │    ├── .vault/
  │    │    ├── settings.json         # Default project settings (committed)
  │    │    └── settings.local.json   # Local override settings (gitignored)
  │    ├── workflows/            # Workflow JSON files
  │    ├── packages/             # Package JSON files
  │    └── ...
  ├── package.json
  ├── vault.js                   # Unified sync engine CLI
  ├── lint-workflows.js          # Pre-seed linter hook
  └── align-workflows.js         # Pre-seed auto-aligner hook
```

---

## ⚙️ Configuration

Each project directory has a `.vault` folder containing connection configurations:

### 1. Default Settings (`.vault/settings.json`)
Contains default connection endpoints (like local development) and lists the tables enabled for synchronization. This file **should be committed** to git.
```json
{
  "supabaseUrl": "http://127.0.0.1:54321",
  "supabaseAnonKey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "enabledTables": [
    "workflows",
    "packages",
    "folders",
    "variables",
    "credentials",
    "tables",
    "table_rows"
  ]
}
```

### 2. Local Override (`.vault/settings.local.json`)
If you want to sync with a different database (e.g., Staging, Production, or a personal cloud DB), create a `settings.local.json` inside the `.vault` directory. This file is **automatically ignored** by Git, preventing sensitive keys from leaking.
```json
{
  "supabaseUrl": "https://your-staging-project.supabase.co",
  "supabaseAnonKey": "eyJhbGciOiJIUzI1Ni..."
}
```

---

## 🚀 CLI Commands

Install dependencies first:
```bash
pnpm install
```

All commands support specifying the project using the `--project=<projectName>` flag (defaults to `crm` if omitted).

### 1. Push (Sync Local -> DB)
Validates structural schema, auto-aligns layout coordinates, and upserts all local JSON files to the target database.
```bash
pnpm run push -- --project=crm
```

### 2. Pull (Sync DB -> Local)
Kéo các bản ghi mới nhất từ database về máy local. 
* **Smart Mapping:** Tự động đối chiếu UUID trong database với các tên file dễ đọc ở local (ví dụ: `Auth - Login.json`) để bảo toàn định dạng đặt tên của bạn, tránh bị đổi tên file thành chuỗi UUID khó đọc.
```bash
pnpm run pull -- --project=crm
```

### 3. Status (Dry-run Compare)
So sánh khác biệt logic giữa Local JSON và Database mà không thay đổi bất kỳ dữ liệu nào.
```bash
pnpm run status -- --project=crm
```

### 4. Lint (Pre-seed Schema Validation)
Chạy bộ kiểm tra cấu trúc workflow và packages để phát hiện sớm các node bị lỗi hoặc các biến chưa khai báo.
```bash
pnpm run lint -- --project=crm
```

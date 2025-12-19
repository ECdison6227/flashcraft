FlashCraft Development Guide & Design System

1. Project Context

FlashCraft is a minimalist, aesthetic flashcard application part of the "Craft Family" suite.
Current State: A single-file HTML/React prototype using localStorage.
Goal: Migrate to a full-stack SaaS using Supabase for backend, while strictly adhering to the Craft Family Design System (CFDS).

2. Craft Family Design System (CFDS) - STRICT COMPLIANCE REQUIRED

You MUST follow these design rules for any new UI components:

2.1 Visual Foundation

Colors:

Primary Black: #171717 (Buttons, Headings)

Background: #f5f5f7 (App Background)

Brand Yellow: #facc15 (Accents, Toggles, Pro Features)

Card White: #ffffff (Cards, Modals)

Text: #1d1d1f

Typography:

UI Font: Inter (System UI)

Code/Numbers: JetBrains Mono

Radius:

Modals/Containers: rounded-[32px] (Large, soft curves)

Buttons/Inputs: rounded-xl or rounded-2xl

2.2 Animation Engine (Tailwind Config)

All interactions must feel fluid and organic. Use existing Tailwind config:

Entrance: animate-blur-in (Blur + Scale Up) for all modals/pages.

Idle: animate-float for logos and empty states.

Click: active:scale-95 for ALL interactive buttons.

Transitions: transition-all duration-300 ease-out.

2.3 Component Patterns

Modals: Centered, backdrop-blur-md, white background, heavy shadow (shadow-2xl).

Headers: Sticky, glassmorphism (bg-white/80 backdrop-blur-md), minimal borders.

Icons: Use lucide-react. Stroke width 2px.

3. Backend Architecture (Supabase)

3.1 Database Schema (PostgreSQL)

profiles:

id (uuid, PK, ref auth.users)

email (text)

is_pro (bool, default false)

role (text, 'user' | 'admin')

decks:

id (uuid, PK)

user_id (uuid, FK profiles.id)

content (jsonb) - Stores the entire deck data (title, desc, cards array).

share_code (text, unique, nullable) - For sharing functionality.

is_public (bool)

redemption_codes:

code (text, PK)

is_used (bool)

created_by (uuid, admin id)

3.2 Key Logic Requirements

A. Authentication

Use supabase-js Auth (Email/Magic Link).

Login View: Must use CFDS style (Minimalist, centered card).

B. Freemium Logic (The "Paywall")

Restriction: Free users max 5 decks. Max 1000 cards/deck.

Check: Before createDeck or importDeck, query DB count.

UI: If limit reached, show PricingModal (already designed).

C. Sharing System (The "Snap")

Generate: Update decks.share_code with a random 6-char string (e.g., FC-8X92).

Import:

User enters code -> Query deck by share_code.

Action: DEEP COPY the content to a NEW deck row for the importer.

Independence: Edits by the original author do NOT affect the importer's copy.

Security: If author regenerates code, the old code becomes invalid for new imports.

D. Admin Dashboard

Access: Only visible if profiles.role === 'admin'.

Features:

Dashboard stats (User count, Pro count).

Generate Redemption Codes (Insert into DB).

4. Implementation Checklist for AI

Setup: Initialize supabaseClient using provided env vars.

Auth Integration: Replace LoginView mock logic with supabase.auth.

Data Layer:

Replace localStorage effects with supabase.from('decks').select/insert/update/delete.

Implement useEffect to fetch data on load.

Business Logic:

Implement createDeck with Limit Check.

Implement generateShareCode and importSharedDeck.

Implement redeemCode RPC call or logic.

Refinement: Ensure all new states (Loading, Error) use CFDS Toasts and Loaders.


---

### 📂 文档二：给你的操作指南 (Product Owner Manual)

**用途**：这是你作为产品负责人（Owner）需要执行的步骤，用来配合 AI 完成上线。

#### 第 1 步：搭建 Supabase 后端 (5分钟)

1.  访问 [Supabase.com](https://supabase.com) 并创建一个新项目（Project）。
2.  进入 **SQL Editor**，复制并运行以下代码（这是 AI 工作的基石）：

```sql
-- 1. 用户表 (Profiles)
create table profiles (
  id uuid references auth.users on delete cascade not null primary key,
  email text,
  is_pro boolean default false,
  role text default 'user', -- 'admin' or 'user'
  created_at timestamptz default now()
);

-- 2. 词书表 (Decks)
create table decks (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references profiles(id) on delete cascade not null,
  content jsonb default '{}'::jsonb, -- 存储 title, desc, cards, theme
  share_code text unique,
  created_at timestamptz default now()
);

-- 3. 兑换码表 (Redemption Codes)
create table redemption_codes (
  code text primary key,
  is_used boolean default false,
  created_at timestamptz default now()
);

-- 4. 自动化：注册时自动创建 Profile
create function public.handle_new_user() 
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 5. 开启 RLS (Row Level Security) - 数据安全核心
alter table profiles enable row level security;
alter table decks enable row level security;

-- 策略：用户只能看/改自己的数据
create policy "Users can view own profile" on profiles for select using (auth.uid() = id);
create policy "Users can CRUD own decks" on decks for all using (auth.uid() = user_id);

-- 策略：分享逻辑 (允许任何人读取有 share_code 的词书)
create policy "Public can view shared decks" on decks for select using (share_code is not null);

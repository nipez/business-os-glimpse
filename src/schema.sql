create extension if not exists "pgcrypto";

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  url text,
  email text,
  phone text,
  ip text,
  user_agent text,
  glimpse jsonb,
  created_at timestamptz default now()
);
create index if not exists leads_domain_idx on leads (domain);
create index if not exists leads_created_at_idx on leads (created_at);

create table if not exists glimpse_cache (
  domain text primary key,
  glimpse jsonb not null,
  created_at timestamptz default now()
);

create table if not exists rate_limits (
  ip text not null,
  bucket timestamptz not null,
  count int default 1,
  primary key (ip, bucket)
);

create table if not exists self_guided_plans (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  website text,
  email text,
  stage text not null,
  team_size text not null,
  tools text not null,
  bottleneck text not null,
  goal text not null,
  owner text not null,
  ip text,
  user_agent text,
  plan jsonb not null,
  created_at timestamptz default now()
);
create index if not exists self_guided_plans_created_at_idx on self_guided_plans (created_at);
create index if not exists self_guided_plans_email_idx on self_guided_plans (email);
create index if not exists self_guided_plans_business_name_idx on self_guided_plans (business_name);

alter table leads enable row level security;
alter table glimpse_cache enable row level security;
alter table rate_limits enable row level security;
alter table self_guided_plans enable row level security;

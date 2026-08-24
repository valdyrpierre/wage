-- Bills table. A split bill (e.g. "split into 3") is stored as multiple
-- rows sharing the same split_group value, each with its own amount and due date.
create table bills (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  amount numeric(10, 2) not null,
  due_date date not null,
  paid boolean not null default false,
  split_group uuid,          -- shared id linking installments of the same original bill, null if not split
  split_label text,           -- e.g. "Part 1 of 3", null if not split
  created_at timestamp with time zone default now()
);

alter table bills enable row level security;

create policy "Users can insert their own bills"
on bills for insert
with check (auth.uid() = user_id);

create policy "Users can view their own bills"
on bills for select
using (auth.uid() = user_id);

create policy "Users can update their own bills"
on bills for update
using (auth.uid() = user_id);

create policy "Users can delete their own bills"
on bills for delete
using (auth.uid() = user_id);
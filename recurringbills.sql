-- Adds support for recurring bills to the existing "bills" table.
-- Run this in the Supabase SQL Editor the same way you ran the earlier scripts.

alter table bills
  add column is_recurring boolean not null default false,
  add column recurring_group uuid;

-- is_recurring: true for any bill that was generated as part of a monthly series
-- recurring_group: shared id linking all occurrences of the same recurring bill,
--                   so deleting one can optionally delete the rest of the series too.
--                   (null for one-off bills, same idea as split_group for split bills)
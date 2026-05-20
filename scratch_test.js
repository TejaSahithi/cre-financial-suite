import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function test() {
  console.log("Testing expenses query...");
  const { data: expenses, error: expError } = await supabase
    .from('expenses')
    .select('*')
    .limit(1);
    
  if (expError) console.error("Expenses error:", expError);
  else console.log("Expenses fetched:", expenses.length, "rows", expenses.length ? Object.keys(expenses[0]) : "");

  console.log("Testing lease_expense_rules query...");
  const { data: rules, error: rulesError } = await supabase
    .from('lease_expense_rules')
    .select('*')
    .limit(1);

  if (rulesError) console.error("Rules error:", rulesError);
  else console.log("Rules fetched:", rules.length, "rows", rules.length ? Object.keys(rules[0]) : "");

  // Now test the specific queries
  const { data: q1, error: e1 } = await supabase.from('expenses').select('*').or("approved_status.eq.approved,review_status.eq.approved");
  if (e1) console.error("Query 1 error:", e1);
  else console.log("Query 1 returned:", q1?.length);

  const { data: q2, error: e2 } = await supabase.from('lease_expense_rules').select('*').in("review_status", ["approved", "mapped"]).or("approval_status.eq.approved,review_status.eq.approved");
  if (e2) console.error("Query 2 error:", e2);
  else console.log("Query 2 returned:", q2?.length);
}

test();

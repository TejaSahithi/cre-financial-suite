import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
  const leaseId = "310ab875-f516-4a2b-94d9-686cf4b87d90";
  const { data: lease, error } = await supabase.from('leases').select('*').eq('id', leaseId).single();
  if (error) {
    console.error(error);
    return;
  }
  
  console.log("Lease Name:", lease.lease_name || lease.name);
  console.log("Lease Type:", lease.lease_type);
  console.log("Has Extraction Data:", !!lease.extraction_data);
  console.log("Workflow Rules Count:", lease.extraction_data?.workflow_output?.expense_rules?.length);
  console.log("Expenses Count:", lease.extraction_data?.expenses?.length);
  console.log("Rules Count:", lease.extraction_data?.rules?.length);
  
  const fileId = lease.extraction_data?.source_file_id || lease.uploaded_file_id || lease.file_id;
  console.log("Source File ID:", fileId);
  
  if (fileId) {
    const { data: file } = await supabase.from('uploaded_files').select('reviewed_output, parsed_data, docling_raw').eq('id', fileId).single();
    if (file) {
      console.log("Has File Reviewed Output:", !!file.reviewed_output);
      console.log("Has File Parsed Full Text:", !!file.parsed_data?.full_text);
      console.log("Has File Docling Text:", !!file.docling_raw?.full_text);
    } else {
      console.log("File not found in uploaded_files");
    }
  }
}

test();

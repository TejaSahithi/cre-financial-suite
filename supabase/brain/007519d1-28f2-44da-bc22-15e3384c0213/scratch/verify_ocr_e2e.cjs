const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Local Supabase config
const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // Or get from npx supabase status

async function testOCR() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const testFile = path.join(__dirname, 'test_scanned.png');
  const base64Content = fs.readFileSync(testFile).toString('base64');

  console.log('--- Triggering API Extraction for Scanned Document ---');
  
  const { data, error } = await supabase.functions.invoke('extract-document-fields', {
    body: {
      moduleType: 'lease',
      fileName: 'test_scanned_image.pdf',
      fileBase64: base64Content,
      fileMimeType: 'application/pdf' // Sending image bytes but claiming it's a PDF to trick the 'scanned' logic if needed
    }
  });

  if (error) {
    console.error('API Error:', error);
    return;
  }

  console.log('Result:', JSON.stringify(data, null, 2));
  
  if (data.method === 'ocr_paddle') {
    console.log('✅ SUCCESS: PaddleOCR was used as fallback!');
  } else {
    console.log('❌ FAILURE: PaddleOCR was NOT used. Extraction method:', data.method);
  }
}

testOCR();

const fs = require('fs');
const data = fs.readFileSync('C:/Users/tejas/.gemini/antigravity-ide/brain/c2b0817e-0c68-4178-bfd2-04569ae557be/.system_generated/steps/8031/output.txt', 'utf8');
const match = data.match(/"field_reviews":\s*({[^}]*})/);
if (match) {
  console.log(match[1]);
} else {
  console.log("No field_reviews found");
}

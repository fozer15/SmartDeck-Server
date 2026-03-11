import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';

const API_URL = 'http://localhost:3000';

async function testGenerateQuiz(pdfPath, instructions = 'Create 5 questions') {
  try {
    const formData = new FormData();
    formData.append('pdf', fs.createReadStream(pdfPath));
    formData.append('instructions', instructions);

    const response = await fetch(`${API_URL}/api/generate-quiz`, {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();
    
    if (data.success) {
      console.log('Success');
      console.log(JSON.stringify(data.data.quiz, null, 2));
    } else {
      console.log('Failed:', data.error);
      if (data.details) console.log(data.details);
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Test with PDF
const pdfPath = 'test.pdf';
if (fs.existsSync(pdfPath)) {
  testGenerateQuiz(pdfPath, 'Create 5 questions focusing on key concepts');
} else {
  console.log(`PDF file "${pdfPath}" not found`);
}

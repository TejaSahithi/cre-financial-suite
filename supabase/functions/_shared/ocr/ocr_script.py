import sys
import argparse
# Import PaddleOCR with suppressed logging to avoid dirtying stdout
import logging
logging.getLogger("ppocr").setLevel(logging.ERROR)

def process_document(file_path):
    try:
        from paddleocr import PaddleOCR
        
        # Initialize OCR (use_angle_cls=True to automatically rotate slanted images)
        # We specify lang='en', and show_log=False to prevent debug info in stdout
        ocr = PaddleOCR(use_angle_cls=True, lang='en', show_log=False)
        
        # Run inference
        result = ocr.ocr(file_path, cls=True)
        
        # Result is a list of blocks, each block is a list of lines
        # format: [[[[x,y],...], (text, confidence)], ...]
        lines = []
        if result and result[0]:
            for line in result[0]:
                if line and len(line) >= 2:
                    text_tuple = line[1]
                    if text_tuple:
                        text = text_tuple[0]
                        lines.append(text)
        
        full_text = "\n".join(lines)
        print(full_text)
        
    except ImportError:
        print("ERROR: paddleocr module not found. Please install via: pip install paddleocr paddlepaddle", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: OCR Failed: {str(e)}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run PaddleOCR on a document.")
    parser.add_argument("file_path", type=str, help="Path to PDF or Image file")
    args = parser.parse_args()
    
    process_document(args.file_path)

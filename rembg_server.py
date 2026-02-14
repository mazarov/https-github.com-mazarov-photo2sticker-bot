"""
rembg API Server
Simple Flask server for background removal using rembg
Model is configured via REMBG_MODEL env variable (default: isnet-general-use)
"""

from flask import Flask, request, Response, jsonify
from rembg import remove, new_session
import io
import os
import time
import logging

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Read model from environment variable
MODEL_NAME = os.environ.get("REMBG_MODEL", "isnet-general-use")

# Pre-load model on startup
logger.info(f"Loading rembg model: {MODEL_NAME}")
session = new_session(MODEL_NAME)
logger.info(f"Model {MODEL_NAME} loaded successfully")


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({'status': 'ok', 'model': MODEL_NAME})


@app.route('/remove-background', methods=['POST'])
def remove_background():
    """
    Remove background from image
    
    Expects: multipart/form-data with 'image' file
    Returns: PNG image with transparent background
    """
    request_id = f"{int(time.time()*1000)}"
    start_time = time.time()
    logger.info(f"[{request_id}] === REQUEST RECEIVED ===")
    
    # Check if image is provided
    if 'image' not in request.files:
        logger.warning(f"[{request_id}] No image in request")
        return jsonify({'error': 'No image provided'}), 400
    
    try:
        # Read input image
        read_start = time.time()
        input_data = request.files['image'].read()
        input_size_kb = len(input_data) / 1024
        read_time = int((time.time() - read_start) * 1000)
        logger.info(f"[{request_id}] Image read: {input_size_kb:.1f} KB in {read_time}ms")
        
        # Remove background
        process_start = time.time()
        logger.info(f"[{request_id}] Starting rembg processing with model={MODEL_NAME}...")
        output_data = remove(
            input_data,
            session=session,
            alpha_matting=True,
            alpha_matting_foreground_threshold=240,
            alpha_matting_background_threshold=10,
            alpha_matting_erode_size=10,
        )
        process_time = int((time.time() - process_start) * 1000)
        logger.info(f"[{request_id}] rembg processing done in {process_time}ms")
        
        # Calculate stats
        duration_ms = int((time.time() - start_time) * 1000)
        output_size_kb = len(output_data) / 1024
        logger.info(f"[{request_id}] === COMPLETED: total={duration_ms}ms, process={process_time}ms, output={output_size_kb:.1f}KB ===")
        
        # Return PNG with transparent background
        return Response(
            output_data,
            mimetype='image/png',
            headers={
                'X-Processing-Time-Ms': str(duration_ms),
                'X-Input-Size-Kb': str(int(input_size_kb)),
                'X-Output-Size-Kb': str(int(output_size_kb)),
                'X-Request-Id': request_id,
            }
        )
        
    except Exception as e:
        duration_ms = int((time.time() - start_time) * 1000)
        logger.error(f"[{request_id}] === ERROR after {duration_ms}ms: {e} ===")
        import traceback
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return jsonify({'error': str(e), 'request_id': request_id}), 500


@app.route('/', methods=['GET'])
def index():
    """Root endpoint with API info"""
    return jsonify({
        'service': 'rembg-api',
        'version': '1.1.0',
        'model': MODEL_NAME,
        'endpoints': {
            '/health': 'GET - Health check',
            '/remove-background': 'POST - Remove background (multipart/form-data with image file)',
        }
    })


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False)

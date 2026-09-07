import sys
import os

def main():
    if len(sys.argv) != 4:
        print("Usage: postprocess_suprem.py <seg_path> <ct_path> <flask_dir>")
        sys.exit(1)
    
    seg_path = sys.argv[1]
    ct_path = sys.argv[2]
    flask_dir = sys.argv[3]
    
    sys.path.insert(0, flask_dir)
    from services.auto_segmentor import _resample_seg_to_ct_grid, _remap_combined_labels, _SUPREM_TO_VIEWER
    
    _resample_seg_to_ct_grid(seg_path, ct_path)
    _remap_combined_labels(seg_path, _SUPREM_TO_VIEWER)

if __name__ == "__main__":
    main()

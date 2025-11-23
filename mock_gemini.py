#!/usr/bin/env python3
"""
Mock Gemini CLI utility for testing web interface.
Mimics the basic interface of the real Gemini CLI.
"""

import argparse
import json
import sys
import time
import random

def main():
    parser = argparse.ArgumentParser(description='Mock Gemini CLI')
    parser.add_argument('--prompt', '-p', help='Prompt to process')
    parser.add_argument('--model', '-m', help='Model to use (ignored in mock)')
    parser.add_argument('--debug', '-d', action='store_true', help='Debug mode')
    parser.add_argument('--mcp-config', help='MCP config file (ignored in mock)')
    parser.add_argument('--yolo', action='store_true', help='YOLO mode (ignored in mock)')

    args = parser.parse_args()

    # Simulate some processing time
    time.sleep(random.uniform(0.5, 2.0))

    if args.debug:
        print("[DEBUG] Mock Gemini CLI starting", file=sys.stderr)

    if args.prompt:
        # Load response templates from JSON file

        # Load and output all structured JSON variants for comprehensive testing
        with open('/mnt/d/u_deepflame_agent/dev/FlamePilot-Web/mock_responses.json') as f:
            responses = json.load(f)

        for response in responses:
            print(json.dumps(response))
            time.sleep(random.uniform(0.5, 1.0))  # Brief pause between variants
        raise RuntimeError("Mock script error: Simulated failure during execution")
    else:
        print("Mock Gemini: Hello! Ready to help with mock responses.")

    if args.debug:
        print("[DEBUG] Mock Gemini CLI finished", file=sys.stderr)

if __name__ == '__main__':
    main()
#!/usr/bin/env python3
"""
Mock Gemini CLI utility for testing web interface.
Mimics the basic interface of the real Gemini CLI.
"""

import argparse
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
        # Simulate Gemini response
        response = f"Mock Gemini response to: '{args.prompt}'"
        if args.model:
            response += f" (using model: {args.model})"
        print(response)
    else:
        print("Mock Gemini: Hello! Ready to help with mock responses.")

    if args.debug:
        print("[DEBUG] Mock Gemini CLI finished", file=sys.stderr)

if __name__ == '__main__':
    main()
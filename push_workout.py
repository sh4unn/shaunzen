#!/usr/bin/env python3
"""
Push a test workout to Garmin Connect.
Usage: python3 push_workout.py
Requires: pip install garminconnect
"""

import os
import json
import getpass
from garminconnect import Garmin

# Credentials — set env vars or enter interactively
EMAIL = os.environ.get("GARMIN_EMAIL") or input("Garmin email: ")
PASSWORD = os.environ.get("GARMIN_PASSWORD") or getpass.getpass("Garmin password: ")

# Zone 2 heart rate targets (bpm) — adjust to your own max HR
# Zone 2 ≈ 60–70% max HR. These are typical defaults for ~180 bpm max.
ZONE2_LOW = 108   # 60% of 180
ZONE2_HIGH = 126  # 70% of 180

workout = {
    "workoutName": "Easy Zone 2 Run — Test",
    "description": "30 min easy run, heart rate zone 2",
    "sportType": {
        "sportTypeId": 1,
        "sportTypeKey": "running",
    },
    "workoutSegments": [
        {
            "segmentOrder": 1,
            "sportType": {
                "sportTypeId": 1,
                "sportTypeKey": "running",
            },
            "workoutSteps": [
                {
                    "stepOrder": 1,
                    "stepType": {"stepTypeId": 3, "stepTypeKey": "warmup"},
                    "childStepId": 1,
                    "description": "Easy warm-up jog",
                    "durationType": {"durationTypeId": 1, "durationTypeKey": "time"},
                    "durationValue": 300,       # 5 minutes in seconds
                    "targetType": {
                        "workoutTargetTypeId": 1,
                        "workoutTargetTypeKey": "no.target",
                    },
                    "targetValueOne": None,
                    "targetValueTwo": None,
                },
                {
                    "stepOrder": 2,
                    "stepType": {"stepTypeId": 1, "stepTypeKey": "interval"},
                    "childStepId": 2,
                    "description": "Zone 2 — conversational pace",
                    "durationType": {"durationTypeId": 1, "durationTypeKey": "time"},
                    "durationValue": 1200,      # 20 minutes in seconds
                    "targetType": {
                        "workoutTargetTypeId": 4,
                        "workoutTargetTypeKey": "heart.rate.zone",
                    },
                    "targetValueOne": ZONE2_LOW,
                    "targetValueTwo": ZONE2_HIGH,
                    "zoneNumber": 2,
                },
                {
                    "stepOrder": 3,
                    "stepType": {"stepTypeId": 4, "stepTypeKey": "cooldown"},
                    "childStepId": 3,
                    "description": "Walk / easy cool-down",
                    "durationType": {"durationTypeId": 1, "durationTypeKey": "time"},
                    "durationValue": 300,       # 5 minutes in seconds
                    "targetType": {
                        "workoutTargetTypeId": 1,
                        "workoutTargetTypeKey": "no.target",
                    },
                    "targetValueOne": None,
                    "targetValueTwo": None,
                },
            ],
        }
    ],
}

def main():
    print("Logging in to Garmin Connect…")
    client = Garmin(EMAIL, PASSWORD)
    client.login()
    print("Logged in.")

    print("Pushing workout…")
    result = client.add_workout(workout)
    print("Done.")
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()

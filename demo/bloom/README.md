# Bloom test application

Bloom is the synthetic photo-journal application used to verify Cue's engineering workflow. Its interface promises uploads up to 5 MB. The seeded server bug limits uploads to 2 MB.

Run `node test.mjs`. The unchanged integration test fails before the fix and passes after the upload limit is corrected. Files above 5 MB must remain rejected. No production customer data is used.

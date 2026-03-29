.PHONY: test test-transcoder test-qc

test: test-transcoder test-qc

test-transcoder:
	cd transcoder && npm test

test-qc:
	cd qc && python -m pytest test_qc.py -v

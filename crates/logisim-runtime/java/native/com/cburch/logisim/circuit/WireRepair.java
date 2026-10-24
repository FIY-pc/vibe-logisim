/* Copyright (c) 2010, Carl Burch. License information is located in the
 * com.cburch.logisim.Main source code and at www.cburch.com/logisim/. */

/*
 * WireRepair of Logisim-ITA 2.16.2.2, which the 2.15 runtime also carries
 * unchanged. Modified for Vibe Logisim in October 2026: doSplits looks up the
 * split points on each wire's line instead of testing every point of the
 * circuit against every wire. It finds the same points and makes the same
 * replacements in the same order, so a loaded circuit is identical; the
 * original scan grew with wires times points and was most of the time it took
 * to load a large file. The bridge's classes precede the runtime on the worker
 * class path, so the worker loads this copy.
 */

package com.cburch.logisim.circuit;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import com.cburch.logisim.comp.Component;
import com.cburch.logisim.data.Location;
import com.cburch.logisim.proj.Project;

class WireRepair extends CircuitTransaction {

	private static class MergeSets {
		private final HashMap<Wire, ArrayList<Wire>> map;

		MergeSets() {
			map = new HashMap<Wire, ArrayList<Wire>>();
		}

		Collection<ArrayList<Wire>> getMergeSets() {
			IdentityHashMap<ArrayList<Wire>, Boolean> lists;
			lists = new IdentityHashMap<ArrayList<Wire>, Boolean>();
			for (ArrayList<Wire> list : map.values()) {
				lists.put(list, Boolean.TRUE);
			}
			return lists.keySet();
		}

		void merge(Wire a, Wire b) {
			ArrayList<Wire> set0 = map.get(a);
			ArrayList<Wire> set1 = map.get(b);
			if (set0 == null && set1 == null) {
				set0 = new ArrayList<Wire>(2);
				set0.add(a);
				set0.add(b);
				map.put(a, set0);
				map.put(b, set0);
			} else if (set0 == null && set1 != null) {
				set1.add(a);
				map.put(a, set1);
			} else if (set0 != null && set1 == null) {
				set0.add(b);
				map.put(b, set0);
			} else if (set0 != set1) { // neither is null, and they are
										// different
				if (set0.size() > set1.size()) { // ensure set1 is the larger
					ArrayList<Wire> temp = set0;
					set0 = set1;
					set1 = temp;
				}
				set1.addAll(set0);
				for (Wire w : set0) {
					map.put(w, set1);
				}
			}
		}
	}

	private Circuit circuit;

	public WireRepair(Circuit circuit) {
		this.circuit = circuit;
	}

	@SuppressWarnings("unlikely-arg-type")
	private void doMerges(CircuitMutator mutator) {
		MergeSets sets = new MergeSets();
		for (Location loc : circuit.wires.points.getSplitLocations()) {
			Collection<?> at = circuit.getComponents(loc);
			if (at.size() == 2) {
				Iterator<?> atit = at.iterator();
				Object at0 = atit.next();
				Object at1 = atit.next();
				if (at0 instanceof Wire && at1 instanceof Wire) {
					Wire w0 = (Wire) at0;
					Wire w1 = (Wire) at1;
					if (w0.isParallel(w1)) {
						sets.merge(w0, w1);
					}
				}
			}
		}

		ReplacementMap repl = new ReplacementMap();
		for (ArrayList<Wire> mergeSet : sets.getMergeSets()) {
			if (mergeSet.size() > 1) {
				ArrayList<Location> locs = new ArrayList<Location>(2 * mergeSet.size());
				for (Wire w : mergeSet) {
					locs.add(w.getEnd0());
					locs.add(w.getEnd1());
				}
				Collections.sort(locs);
				Location e0 = locs.get(0);
				Location e1 = locs.get(locs.size() - 1);
				Wire wnew = Wire.create(e0, e1);
				Collection<Wire> wset = Collections.singleton(wnew);

				for (Wire w : mergeSet) {
					if (!w.equals(wset)) {
						repl.put(w, wset);
					}
				}
			}
		}
		mutator.replace(circuit, repl, null);
	}

	private void doMergeSet(ArrayList<Wire> mergeSet, ReplacementMap replacements, Set<Location> splitLocs) {
		TreeSet<Location> ends = new TreeSet<Location>();
		for (Wire w : mergeSet) {
			ends.add(w.getEnd0());
			ends.add(w.getEnd1());
		}
		Wire whole = Wire.create(ends.first(), ends.last());

		TreeSet<Location> mids = new TreeSet<Location>();
		mids.add(whole.getEnd0());
		mids.add(whole.getEnd1());
		for (Location loc : whole) {
			if (splitLocs.contains(loc)) {
				for (Component comp : circuit.getComponents(loc)) {
					if (!mergeSet.contains(comp)) {
						mids.add(loc);
						break;
					}
				}
			}
		}

		ArrayList<Wire> mergeResult = new ArrayList<Wire>();
		if (mids.size() == 2) {
			mergeResult.add(whole);
		} else {
			Location e0 = mids.first();
			for (Location e1 : mids) {
				mergeResult.add(Wire.create(e0, e1));
				e0 = e1;
			}
		}

		for (Wire w : mergeSet) {
			ArrayList<Component> wRepl = new ArrayList<Component>(2);
			for (Wire w2 : mergeResult) {
				if (w2.overlaps(w, false)) {
					wRepl.add(w2);
				}
			}
			replacements.put(w, wRepl);
		}
	}

	/*
	 * for debugging: private void printWires(String prefix, PrintStream out) {
	 * boolean first = true; for (Wire w : circuit.getWires()) { if (first) {
	 * out.println(prefix + ": " + w); first = false; } else { out.println( "      "
	 * + w); } } out.println(prefix + ": none"); }
	 */

	private void doOverlaps(CircuitMutator mutator) {
		HashMap<Location, ArrayList<Wire>> wirePoints;
		wirePoints = new HashMap<Location, ArrayList<Wire>>();
		for (Wire w : circuit.getWires()) {
			for (Location loc : w) {
				ArrayList<Wire> locWires = wirePoints.get(loc);
				if (locWires == null) {
					locWires = new ArrayList<Wire>(3);
					wirePoints.put(loc, locWires);
				}
				locWires.add(w);
			}
		}

		MergeSets mergeSets = new MergeSets();
		for (ArrayList<Wire> locWires : wirePoints.values()) {
			if (locWires.size() > 1) {
				for (int i = 0, n = locWires.size(); i < n; i++) {
					Wire w0 = locWires.get(i);
					for (int j = i + 1; j < n; j++) {
						Wire w1 = locWires.get(j);
						if (w0.overlaps(w1, false)) {
							mergeSets.merge(w0, w1);
						}
					}
				}
			}
		}

		ReplacementMap replacements = new ReplacementMap();
		Set<Location> splitLocs = circuit.wires.points.getSplitLocations();
		for (ArrayList<Wire> mergeSet : mergeSets.getMergeSets()) {
			if (mergeSet.size() > 1) {
				doMergeSet(mergeSet, replacements, splitLocs);
			}
		}
		mutator.replace(circuit, replacements, null);
	}

	private void doSplits(CircuitMutator mutator) {
		Set<Location> splitLocs = circuit.wires.points.getSplitLocations();
		// Wire.contains accepts points within 2 of the wire's line, so a
		// horizontal wire reads rows y-2..y+2 and a vertical one columns.
		HashMap<Integer, ArrayList<Location>> rows = new HashMap<Integer, ArrayList<Location>>();
		HashMap<Integer, ArrayList<Location>> columns = new HashMap<Integer, ArrayList<Location>>();
		for (Location loc : splitLocs) {
			rows.computeIfAbsent(loc.getY(), k -> new ArrayList<Location>()).add(loc);
			columns.computeIfAbsent(loc.getX(), k -> new ArrayList<Location>()).add(loc);
		}
		ReplacementMap repl = new ReplacementMap();
		for (Wire w : circuit.getWires()) {
			Location w0 = w.getEnd0();
			Location w1 = w.getEnd1();
			ArrayList<Location> splits = null;
			boolean vertical = w.isVertical();
			int line = vertical ? w0.getX() : w0.getY();
			HashMap<Integer, ArrayList<Location>> lines = vertical ? columns : rows;
			for (int at = line - 2; at <= line + 2; at++) {
				ArrayList<Location> candidates = lines.get(at);
				if (candidates == null)
					continue;
				for (Location loc : candidates) {
					if (w.contains(loc) && !loc.equals(w0) && !loc.equals(w1)) {
						if (splits == null)
							splits = new ArrayList<Location>();
						splits.add(loc);
					}
				}
			}
			if (splits != null) {
				splits.add(w1);
				Collections.sort(splits);
				Location e0 = w0;
				ArrayList<Wire> subs = new ArrayList<Wire>(splits.size());
				for (Location e1 : splits) {
					subs.add(Wire.create(e0, e1));
					e0 = e1;
				}
				repl.put(w, subs);
			}
		}
		mutator.replace(circuit, repl, null);
	}

	@Override
	protected Map<Circuit, Integer> getAccessedCircuits() {
		return Collections.singletonMap(circuit, READ_WRITE);
	}

	@Override
	protected void run(CircuitMutator mutator, Project proj) {
		doMerges(mutator);
		doOverlaps(mutator);
		doSplits(mutator);
	}
}

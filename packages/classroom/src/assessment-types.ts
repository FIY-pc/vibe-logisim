export interface AssessmentCase {
  id: string;
  title: string;
  hidden: boolean;
  inputs: Record<string, number>;
  expected: Record<string, number>;
}
export interface LessonImage {
  id: string;
  name: string;
  data: string;
}
export interface Lesson {
  id: string;
  chapterId: string;
  title: string;
  description: string;
  position: number;
  published: boolean;
  /** Score a student earns for passing every case at the grading version. */
  points: number;
  version: number;
  gradingVersion: number;
  circuit: string;
  templateName: string;
  templateXml: string;
  images: LessonImage[];
  tests: AssessmentCase[];
  testCount: number;
  hiddenCount: number;
}
export interface Chapter {
  id: string;
  title: string;
  description: string;
  position: number;
  lessons: (Pick<
    Lesson,
    | "id"
    | "title"
    | "position"
    | "published"
    | "version"
    | "points"
    | "testCount"
    | "hiddenCount"
  > & { passed: boolean; attempts: number })[];
}
export interface CaseResult {
  id: string;
  title: string;
  hidden: boolean;
  passed: boolean;
  inputs?: Record<string, number>;
  expected?: Record<string, number>;
  outputs?: Record<string, { bits: string; value?: number }>;
  oscillating?: boolean;
}
export interface AssessmentAttempt {
  id: string;
  lessonId: string;
  studentId: string;
  studentName: string;
  studentNo: string;
  lessonVersion: number;
  name: string;
  createdAt: string;
  finishedAt: string | null;
  status: "queued" | "running" | "passed" | "failed" | "error";
  passed: number;
  total: number;
  result: CaseResult[];
  message: string;
}
export interface GradeInput {
  xml: string;
  circuit: string;
  tests: AssessmentCase[];
}
export type GradeRunner = (input: GradeInput) => Promise<{
  rows: {
    oscillating: boolean;
    outputs: Record<string, { bits: string; value?: number }>;
  }[];
}>;

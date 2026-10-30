export interface ClassroomUser {
  id: string;
  username: string;
  name: string;
  role: "teacher" | "student";
  studentNo: string;
}
export interface Classroom {
  id: string;
  title: string;
  task: string;
  rubric: string;
  teacherName: string;
  code?: string;
  archived: boolean;
  capacity: number;
  createdAt: string;
  memberCount: number;
}
export interface SharedMessage {
  id: string;
  type: "user" | "assistant" | "activity";
  text: string;
  status?: string;
}
export interface WorkSnapshot {
  image?: string;
  name: string;
  xml: string;
  revision: string;
  circuit: string;
  components: number;
  wires: number;
  conversationId: string | null;
  messages: SharedMessage[];
  status: "working" | "submitted";
  progress: number;
  note: string;
}
export interface SubmissionSummary {
  id: string;
  studentId: string;
  createdAt: string;
  name: string;
  status: "working" | "submitted";
  progress: number;
  revision: string;
  components: number;
  wires: number;
  questions: number;
  toolErrors: number;
}
export interface ClassroomMember {
  user: ClassroomUser;
  joinedAt: string;
  latest: SubmissionSummary | null;
  submissionCount: number;
}
export interface Submission extends SubmissionSummary {
  snapshot: WorkSnapshot;
}
export interface AnalysisReport {
  id: string;
  createdAt: string;
  text: string;
  model: string;
  question: string;
  studentId: string | null;
  evidence: string[];
  coveredStudents: number;
  totalStudents: number;
}
export interface ClassroomDetail {
  provider?: ClassroomProvider | null;
  classroom: Classroom;
  members: ClassroomMember[];
  analyses: AnalysisReport[];
  aiAvailable: boolean;
}
export interface ClassroomProvider {
  name: string;
  baseUrl: string;
  api: string;
  model: string;
  effort: string;
  contextWindow: number;
  vision: boolean;
  enabled: boolean;
  updatedAt: string;
}

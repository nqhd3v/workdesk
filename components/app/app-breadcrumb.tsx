"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { CRUMB_LABELS } from "./nav";

export function AppBreadcrumb() {
  const pathname = usePathname();

  // "/settings/api-keys" -> ["/settings", "/settings/api-keys"]
  const segments = pathname.split("/").filter(Boolean);
  const crumbs = segments
    .map((_, i) => "/" + segments.slice(0, i + 1).join("/"))
    .filter((href) => CRUMB_LABELS[href])
    .map((href) => ({ href, label: CRUMB_LABELS[href] }));
  if (crumbs.length === 0) crumbs.push({ href: "/", label: "Dashboard" });

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, i) => (
          <Fragment key={crumb.href}>
            {i > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {i === crumbs.length - 1 ? (
                <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink render={<Link href={crumb.href} />}>{crumb.label}</BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
